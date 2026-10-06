import * as path from 'node:path';
import { AGENT_PROVIDER_PRESETS, inferAgentProvider, isAgentProvider, providerPreset, type AgentProvider } from '../shared/agentProvider';
import { argsHaveAutoFlag, normalizeAutoFlagCommand } from '../shared/autoModeFlag';
import type { AgentMeta } from './hive';

/**
 * Agent spawn policy (O.9 #6 and #7). Pure, so every rule is unit-tested
 * (test/nexus-spawn-policy.test.cjs); index.ts only wires it to IPC, the
 * confirmation dialog and the worker spawn-request watcher.
 *
 * The renderer names an engine binary; main decides whether that binary may
 * run. Known provider CLIs, the user's configured default command and engines
 * the user already allowed run directly. Any other program needs a main-process
 * confirmation. Anything that looks like shell syntax is refused outright.
 * God-authored worker spawn-requests may only name a provider preset id.
 */

export interface SpawnPolicyConfig {
  defaultCommand?: string;
  /** Exact command lines (binary + args, see commandLineKey) the user allowed. */
  trustedEngineCommands?: readonly string[];
  /** Whether the floor is in auto mode: the preset's autonomy/bypass flags are
   *  on the allow-list only then, because only then does the app add them. */
  autoMode?: boolean;
}

export type CommandVerdict =
  | { ok: true; source: 'preset' | 'configured' | 'trusted' }
  | { ok: false; reason: 'needs-confirmation' | 'invalid' | 'forbidden' };

/** What the renderer may ask `pty:spawn` for. No `env`, `shellScript` or
 *  `noAutoInstall`: those are set by main only. */
export interface RendererSpawnRequest {
  id: string;
  cwd: string;
  command: string;
  args: string[];
  cols?: number;
  rows?: number;
  provider?: AgentProvider;
  hive?: AgentMeta;
  isolate?: boolean;
  resume?: boolean;
  requireResume?: boolean;
  resumeSessionId?: string;
}

/** Shell metacharacters and control characters never allowed in an engine
 *  binary. Parentheses are refused in bare names only (a Windows path such as
 *  `C:\Program Files (x86)\...` legitimately has them). */
const SHELL_META = /[&|;<>^%$`"'!*?\r\n\t\0\u000b\u000c]/;
const BARE_NAME_EXTRA = /[\s()]/;
/** Characters a renderer-supplied argument may never contain: cmd.exe cannot
 *  carry them safely even inside quotes (quote toggling, %VAR% and !VAR!
 *  expansion, statement breaks), and no app-built argument needs them. */
export const RENDERER_ARG_FORBIDDEN = /["%!\r\n\0]/;

/** Quote-aware argv split, the same rules as the renderer's `tokenizeCommand`
 *  (store/config.ts), so the configured command's binary is compared in the
 *  exact form the renderer sends it. */
export function tokenizeCommandLine(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function isAbsoluteAnyPlatform(p: string): boolean {
  return path.win32.isAbsolute(p) || path.posix.isAbsolute(p);
}

/** The binaries of every provider preset (`claude`, `codex`, `agy`, …). */
export function presetBinaries(): string[] {
  const out: string[] = [];
  for (const p of AGENT_PROVIDER_PRESETS) {
    const bin = (p.defaultCommand ?? '').trim().split(/\s+/)[0];
    if (bin && !out.includes(bin)) out.push(bin);
  }
  return out;
}

function isWellFormedBinary(bin: string): boolean {
  if (!bin) return false;
  if (SHELL_META.test(bin)) return false;
  const hasSeparator = /[\\/]/.test(bin);
  if (!hasSeparator) return !BARE_NAME_EXTRA.test(bin);
  // A path may contain plain spaces only when it is absolute (C:\Program Files\...).
  if (/\s/.test(bin) && !isAbsoluteAnyPlatform(bin)) return false;
  return true;
}

/** Shells and script interpreters are never agent engines, not even after the
 *  confirmation dialog: with them any argument is a program. Matched by
 *  basename, any case, with or without an extension or a path. A provider whose
 *  launcher is a node script still works: its preset binary is the npm shim
 *  (`claude.cmd`), which pty.ts decodes to node + script itself. */
export const FORBIDDEN_ENGINES: readonly string[] = [
  'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'wscript', 'cscript', 'mshta',
  'node', 'python', 'python3', 'py', 'deno', 'bun'
];

/** The bare program name: no directory, no extension, lower case. */
export function engineBasename(bin: string): string {
  const leaf = bin.split(/[\\/]/).pop() ?? bin;
  return leaf.toLowerCase().replace(/\.[a-z0-9]+$/, '');
}

export function isForbiddenEngine(bin: string): boolean {
  return typeof bin === 'string' && FORBIDDEN_ENGINES.includes(engineBasename(bin.trim()));
}

/** How a flag on a preset's allow-list may be followed. */
type FlagRule =
  | { kind: 'none' }                       // a switch, no value
  | { kind: 'value'; re: RegExp }          // takes one value matching `re`
  | { kind: 'exact'; values: string[] };   // takes one of these exact values

/** A model or session value must start with a letter or digit, so it can never
 *  read as a flag (`--model --settings=x`) to the CLI that receives it. */
export const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._()[\]/:@+-]{0,79}$/;
export const SESSION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The flags a renderer may pass to a preset CLI without a confirmation: exactly
 * what the app itself generates.
 *  - the model flag (buildSpawnCommand, the Add Agent model picker);
 *  - the resume/session flag (a persisted command line can carry it);
 *  - the preset's autonomy/bypass flag, only while config.autoMode is on
 *    (buildSpawnCommand appends it from config, nothing else does);
 *  - the hire-manifest safe flags (shared/hire.ts SAFE_FLAG_NAMES):
 *    `--max-turns`, `--output-format`, `--verbose`.
 * Never on any list: `--settings`, `--mcp-config`, `--append-system-prompt`,
 * `--system-prompt`, `-c`/`--config`, `--add-dir`, `--plugin-dir`, `--profile`,
 * or anything else that can inject config, hooks, prompts or directories.
 * Main adds its own hive flags after this check; they are not renderer input.
 */
export function presetFlagAllowList(provider: AgentProvider, cfg: Pick<SpawnPolicyConfig, 'autoMode'> = {}): Map<string, FlagRule> {
  const preset = providerPreset(provider);
  const rules = new Map<string, FlagRule>();
  if (provider === 'custom') return rules;
  if (preset.modelFlag) rules.set(preset.modelFlag, { kind: 'value', re: MODEL_VALUE });
  if (preset.resumeFlag) rules.set(preset.resumeFlag, { kind: 'value', re: SESSION_VALUE });
  if (cfg.autoMode === true && preset.autoFlag) {
    const toks = preset.autoFlag.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t.startsWith('-')) continue;
      const next = toks[i + 1];
      if (next !== undefined && !next.startsWith('-')) { rules.set(t, { kind: 'exact', values: [next] }); i++; }
      else rules.set(t, { kind: 'none' });
    }
  }
  rules.set('--max-turns', { kind: 'value', re: /^[1-9][0-9]{0,5}$/ });
  rules.set('--output-format', { kind: 'exact', values: ['text', 'json', 'stream-json'] });
  rules.set('--verbose', { kind: 'none' });
  return rules;
}

function valueFits(rule: FlagRule, v: string): boolean {
  if (rule.kind === 'value') return rule.re.test(v);
  if (rule.kind === 'exact') return rule.values.includes(v);
  return false;
}

/** Whether every arg is an allowed flag (with an allowed value). */
export function argsWithinAllowList(args: readonly string[], rules: Map<string, FlagRule>): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string' || !a.startsWith('-')) return false;
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    const rule = rules.get(name);
    if (!rule) return false;
    if (eq > 0) {
      if (!valueFits(rule, a.slice(eq + 1))) return false;
      continue;
    }
    if (rule.kind === 'none') continue;
    const v = args[i + 1];
    if (v === undefined || !valueFits(rule, v)) return false;
    i++;
  }
  return true;
}

/** One readable, unambiguous line for an argv (binary + args). Tokens with
 *  whitespace (or empty) are double-quoted; renderer args cannot contain `"`
 *  (sanitizeSpawnRequest) and binaries cannot either, so the line maps back to
 *  exactly one argv. This is what the dialog shows and what Allow remembers. */
export function commandLineKey(bin: string, args: readonly string[]): string {
  return [bin, ...args].map((t) => (t === '' || /\s/.test(t) ? `"${t}"` : t)).join(' ');
}

/** The preset a bare binary names (`claude`, `Codex.exe`, `antigravity`), or null. */
function presetForBinary(bin: string): AgentProvider | null {
  if (/[\\/]/.test(bin)) return null;
  const leaf = bin.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (leaf === 'antigravity') return 'antigravity';
  const p = AGENT_PROVIDER_PRESETS.find((x) => x.id !== 'custom' && x.defaultCommand && x.defaultCommand.trim().split(/\s+/)[0] === leaf);
  return p ? p.id : null;
}

/**
 * Classify a full renderer spawn: binary AND args (O.9 #6, fix round 1).
 *  - invalid: shell syntax in the binary;
 *  - forbidden: a shell or interpreter (never runnable, even with the dialog);
 *  - preset / configured: the binary is a provider CLI (or the configured
 *    default command) and every arg is on that provider's flag allow-list
 *    (the configured command's own args count as allowed too);
 *  - trusted: this EXACT command line was allowed in the dialog before;
 *  - otherwise needs-confirmation, for this exact command line only.
 */
export function classifySpawn(
  command: string,
  args: readonly string[],
  cfg: SpawnPolicyConfig,
  provider?: AgentProvider
): CommandVerdict {
  if (typeof command !== 'string') return { ok: false, reason: 'invalid' };
  // Control characters are refused anywhere, even where trim() would drop them.
  if (SHELL_META.test(command)) return { ok: false, reason: 'invalid' };
  const bin = command.trim();
  if (!isWellFormedBinary(bin)) return { ok: false, reason: 'invalid' };
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) return { ok: false, reason: 'invalid' };
  if (isForbiddenEngine(bin)) return { ok: false, reason: 'forbidden' };

  const preset = presetForBinary(bin);
  if (preset && argsWithinAllowList(args, presetFlagAllowList(preset, cfg))) return { ok: true, source: 'preset' };

  // Auto mode off: a line that carries a preset's bypass flag is never run on
  // the strength of the configured command or a trusted entry (finding 1b).
  if (autoFlagBlocked(bin, args, cfg, provider)) return { ok: false, reason: 'needs-confirmation' };

  const configuredToks = typeof cfg.defaultCommand === 'string' ? tokenizeCommandLine(cfg.defaultCommand.trim()) : [];
  if (configuredToks[0] && configuredToks[0] === bin) {
    const confArgs = configuredToks.slice(1);
    // The configured command's own args may lead; the rest must fit the
    // allow-list of the provider it runs (inferred from the binary).
    const leads = confArgs.every((a, i) => args[i] === a);
    const rest = leads ? args.slice(confArgs.length) : args;
    const prov = inferAgentProvider(bin, provider === 'custom' ? undefined : provider);
    if (argsWithinAllowList(rest, presetFlagAllowList(prov, cfg))) return { ok: true, source: 'configured' };
  }

  const trusted = Array.isArray(cfg.trustedEngineCommands) ? cfg.trustedEngineCommands : [];
  if (trusted.includes(commandLineKey(bin, args))) return { ok: true, source: 'trusted' };
  return { ok: false, reason: 'needs-confirmation' };
}

/**
 * Whether this command line carries a preset's auto (bypass) flag while auto
 * mode is off (B0a final review, finding 1b). Such a line is never trusted,
 * never accepted as the configured command, and the engine dialog is not
 * offered for it: allowing it would run the agent in bypass with auto mode off.
 */
export function autoFlagBlocked(
  command: string,
  args: readonly string[],
  cfg: Pick<SpawnPolicyConfig, 'autoMode'>,
  provider?: AgentProvider
): boolean {
  if (cfg.autoMode === true) return false;
  const bin = typeof command === 'string' ? command.trim() : '';
  const prov = presetForBinary(bin) ?? inferAgentProvider(bin, provider === 'custom' ? undefined : provider);
  return argsHaveAutoFlag(args, prov);
}

/** Classify an engine binary run with no arguments (the brief's interface). */
export function classifySpawnCommand(command: string, cfg: SpawnPolicyConfig): CommandVerdict {
  return classifySpawn(command, [], cfg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sanitizeHive(raw: unknown): AgentMeta | null {
  if (!isPlainObject(raw)) return null;
  const { id, name, cwd } = raw;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof cwd !== 'string') return null;
  const meta: AgentMeta = { id, name, cwd };
  if (isAgentProvider(raw.provider)) meta.provider = raw.provider;
  if (typeof raw.role === 'string') meta.role = raw.role;
  if (Array.isArray(raw.capabilities)) meta.capabilities = raw.capabilities.filter((c): c is string => typeof c === 'string');
  if (raw.isGod === true) meta.isGod = true;
  if (raw.isAssistant === true) meta.isAssistant = true;
  return meta;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

/**
 * Rebuild a renderer `pty:spawn` request from known fields only. Unknown keys
 * (`env`, `shellScript`, `noAutoInstall`, anything else) never reach the spawn
 * core. Malformed required fields reject the request.
 */
export function sanitizeSpawnRequest(raw: unknown): { ok: true; opts: RendererSpawnRequest } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: 'invalid SpawnOptions' };
  const { id, cwd, command } = raw;
  if (typeof id !== 'string' || !id || typeof cwd !== 'string' || typeof command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  let args: string[] = [];
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === 'string')) {
      return { ok: false, error: 'invalid SpawnOptions: args must be strings' };
    }
    // Refused outright rather than escaped (see RENDERER_ARG_FORBIDDEN).
    const bad = raw.args.find((a) => RENDERER_ARG_FORBIDDEN.test(a));
    if (bad !== undefined) {
      return { ok: false, error: `Not started: an agent argument contains a character that is not allowed (" % ! or a line break): ${JSON.stringify(bad)}` };
    }
    args = [...raw.args];
  }
  const opts: RendererSpawnRequest = { id, cwd, command, args };
  const cols = positiveInt(raw.cols);
  const rows = positiveInt(raw.rows);
  if (cols !== undefined) opts.cols = cols;
  if (rows !== undefined) opts.rows = rows;
  if (isAgentProvider(raw.provider)) opts.provider = raw.provider;
  if (raw.hive !== undefined && raw.hive !== null) {
    const hive = sanitizeHive(raw.hive);
    if (!hive) return { ok: false, error: 'invalid SpawnOptions: hive' };
    opts.hive = hive;
  }
  if (typeof raw.isolate === 'boolean') opts.isolate = raw.isolate;
  if (typeof raw.resume === 'boolean') opts.resume = raw.resume;
  if (typeof raw.requireResume === 'boolean') opts.requireResume = raw.requireResume;
  if (typeof raw.resumeSessionId === 'string') opts.resumeSessionId = raw.resumeSessionId;
  return { ok: true, opts };
}

const WORKER_COMMAND_ERROR = '"command" must be a provider id (claude, codex, …), not a program path.';

/** A provider id that has a runnable preset binary (`custom` has none). */
function runnablePresetId(v: unknown): AgentProvider | null {
  if (!isAgentProvider(v) || v === 'custom') return null;
  return providerPreset(v).defaultCommand ? v : null;
}

/**
 * The engine command for a god-authored worker spawn-request (O.9 #7). Only a
 * provider preset id is accepted, in `provider` or (for old requests) as a bare
 * id in `command`; the binary always comes from the preset. With neither, the
 * user's configured default command runs.
 */
export function resolveWorkerCommand(
  raw: { command?: unknown; provider?: unknown },
  cfg: { defaultCommand?: string; autoMode?: boolean }
): { ok: true; command: string; provider?: AgentProvider } | { ok: false; error: string } {
  let fromProvider: AgentProvider | null = null;
  if (raw.provider !== undefined && raw.provider !== null && raw.provider !== '') {
    fromProvider = runnablePresetId(raw.provider);
    if (!fromProvider) return { ok: false, error: '"provider" must be a provider id (claude, codex, …).' };
  }
  let fromCommand: AgentProvider | null = null;
  if (raw.command !== undefined && raw.command !== null && raw.command !== '') {
    fromCommand = typeof raw.command === 'string' ? runnablePresetId(raw.command.trim()) : null;
    if (!fromCommand) return { ok: false, error: WORKER_COMMAND_ERROR };
  }
  if (fromProvider && fromCommand && fromProvider !== fromCommand) {
    return { ok: false, error: '"command" and "provider" name different engines.' };
  }
  const id = fromProvider ?? fromCommand;
  if (id) return { ok: true, command: providerPreset(id).defaultCommand, provider: id };
  const configured = typeof cfg.defaultCommand === 'string' ? cfg.defaultCommand.trim() : '';
  // A legacy defaultCommand may still carry a preset auto flag; match it to the
  // current autoMode like every other respawn path does.
  return { ok: true, command: normalizeAutoFlagCommand(configured || 'claude', cfg.autoMode === true) };
}

/**
 * The renderer may only REMOVE allowed engines (Settings → Agents & Models);
 * adding one happens only through the main-process confirmation dialog. Keeps
 * the proposed entries that are already trusted, in the proposed order.
 */
export function shrinkTrustedEngines(proposed: unknown, current: readonly string[] | undefined): string[] {
  const have = Array.isArray(current) ? current : [];
  if (!Array.isArray(proposed)) return [...have];
  const out: string[] = [];
  for (const p of proposed) {
    if (typeof p === 'string' && have.includes(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Append a confirmed engine to the trusted list (deduplicated). While auto
 *  mode is off, a line carrying a preset's auto flag is refused and the list
 *  comes back unchanged (finding 1b), so trust can never re-enable bypass. */
export function addTrustedEngine(
  current: readonly string[] | undefined,
  command: string,
  cfg?: Pick<SpawnPolicyConfig, 'autoMode'>,
  provider?: AgentProvider
): string[] {
  const have = Array.isArray(current) ? current.filter((c) => typeof c === 'string') : [];
  if (cfg && cfg.autoMode !== true) {
    const [bin, ...args] = tokenizeCommandLine(command);
    if (bin && autoFlagBlocked(bin, args, cfg, provider)) return [...have];
  }
  return have.includes(command) ? [...have] : [...have, command];
}

/** The confirmation dialog text (verbatim from the Task 11 brief). */
export function engineConfirmText(commandLine: string, cwd: string): { message: string; detail: string } {
  return {
    message: `Run “${commandLine}” as an agent engine?`,
    detail: `Nexus only starts known agent CLIs. Allow this program to run as an agent in ${cwd}? You can remove it later in Settings → Agents & Models.`
  };
}

export const ENGINE_NOT_ALLOWED = 'Not started: this program is not an allowed agent engine.';
export const ENGINE_INVALID = 'Not started: the agent engine must be a program name or path, not shell syntax.';
export const ENGINE_AUTO_FLAG_OFF = 'Not started: this command line turns on auto mode, which is off. Start the agent without that flag, or turn auto mode on in Settings.';
export const ENGINE_FORBIDDEN = 'Not started: shells and script interpreters (cmd, PowerShell, bash, node, python, …) cannot run as an agent engine.';
