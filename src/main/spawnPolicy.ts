import * as path from 'node:path';
import { AGENT_PROVIDER_PRESETS, isAgentProvider, providerPreset, type AgentProvider } from '../shared/agentProvider';
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
  trustedEngineCommands?: readonly string[];
}

export type CommandVerdict =
  | { ok: true; source: 'preset' | 'configured' | 'trusted' }
  | { ok: false; reason: 'needs-confirmation' | 'invalid' };

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

/** A bare (PATH-resolved) spelling of a preset binary: any case, with a
 *  Windows launcher extension (`claude.cmd`, `Codex.exe`), or the `antigravity`
 *  alias that inferAgentProvider and the voice actions use for `agy`. Paths
 *  never count: a program merely NAMED claude.exe somewhere is not the preset. */
function isBarePresetAlias(bin: string): boolean {
  if (/[\\/]/.test(bin)) return false;
  const leaf = bin.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  return leaf === 'antigravity' || presetBinaries().includes(leaf);
}

/** Classify the engine binary a renderer asked to run. */
export function classifySpawnCommand(command: string, cfg: SpawnPolicyConfig): CommandVerdict {
  if (typeof command !== 'string') return { ok: false, reason: 'invalid' };
  // Control characters are refused anywhere, even where trim() would drop them.
  if (SHELL_META.test(command)) return { ok: false, reason: 'invalid' };
  const bin = command.trim();
  if (!isWellFormedBinary(bin)) return { ok: false, reason: 'invalid' };
  if (presetBinaries().includes(bin) || isBarePresetAlias(bin)) return { ok: true, source: 'preset' };
  const configured = typeof cfg.defaultCommand === 'string' ? tokenizeCommandLine(cfg.defaultCommand.trim())[0] : undefined;
  if (configured && configured === bin) return { ok: true, source: 'configured' };
  const trusted = Array.isArray(cfg.trustedEngineCommands) ? cfg.trustedEngineCommands : [];
  if (trusted.includes(bin)) return { ok: true, source: 'trusted' };
  return { ok: false, reason: 'needs-confirmation' };
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
  cfg: { defaultCommand?: string }
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
  return { ok: true, command: configured || 'claude' };
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

/** Append a confirmed engine to the trusted list (deduplicated). */
export function addTrustedEngine(current: readonly string[] | undefined, command: string): string[] {
  const have = Array.isArray(current) ? current.filter((c) => typeof c === 'string') : [];
  return have.includes(command) ? [...have] : [...have, command];
}

/** The confirmation dialog text (verbatim from the Task 11 brief). */
export function engineConfirmText(command: string, cwd: string): { message: string; detail: string } {
  return {
    message: `Run “${command}” as an agent engine?`,
    detail: `Nexus only starts known agent CLIs. Allow this program to run as an agent in ${cwd}? You can remove it later in Settings → Agents & Models.`
  };
}

export const ENGINE_NOT_ALLOWED = 'Not started: this program is not an allowed agent engine.';
export const ENGINE_INVALID = 'Not started: the agent engine must be a program name or path, not shell syntax.';
