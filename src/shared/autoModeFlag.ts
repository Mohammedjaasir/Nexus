/**
 * Auto mode flags on agent command lines (B0a final review, finding 1).
 *
 * A persisted agent command (`Agent.command`) is the exact line the agent was
 * started with, so a line saved while auto mode was on carries the preset's
 * bypass flag (Claude `--permission-mode bypassPermissions`, Codex
 * `--dangerously-bypass-approvals-and-sandbox`, …). Respawning that line after
 * auto mode was turned off would either need the engine dialog (and, once
 * allowed, keep bypass on) or fail. Every respawn path therefore normalises the
 * line to the CURRENT `config.autoMode` first: strip the provider's own auto
 * flag when auto mode is off, add it when auto mode is on.
 *
 * Shared between main and renderer; dependency-free apart from the presets.
 */
import { AGENT_PROVIDER_PRESETS, inferAgentProvider, providerPreset, type AgentProvider } from './agentProvider';

/** One auto-flag unit: a switch, or a flag followed by its fixed value. */
export interface AutoFlagUnit {
  flag: string;
  value?: string;
}

/** The units of a provider's auto flag (`--permission-mode bypassPermissions`
 *  is one unit with a value; copilot's `-s --allow-all-tools --no-ask-user` is
 *  three switches). Empty for a provider without one. */
export function autoFlagUnits(provider: AgentProvider): AutoFlagUnit[] {
  const raw = (providerPreset(provider).autoFlag ?? '').trim();
  if (!raw) return [];
  const toks = raw.split(/\s+/).filter(Boolean);
  const units: AutoFlagUnit[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t.startsWith('-')) continue;
    const next = toks[i + 1];
    if (next !== undefined && !next.startsWith('-')) { units.push({ flag: t, value: next }); i++; }
    else units.push({ flag: t });
  }
  return units;
}

/** How many args at `i` the unit covers (0 = no match). Accepts `--flag value`
 *  and `--flag=value` for a valued unit. */
function unitMatchAt(args: readonly string[], i: number, u: AutoFlagUnit): number {
  const a = args[i];
  if (u.value === undefined) return a === u.flag ? 1 : 0;
  if (a === `${u.flag}=${u.value}`) return 1;
  if (a === u.flag && args[i + 1] === u.value) return 2;
  return 0;
}

function stripUnits(args: readonly string[], units: readonly AutoFlagUnit[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; ) {
    let n = 0;
    for (const u of units) { n = unitMatchAt(args, i, u); if (n) break; }
    if (n) { i += n; continue; }
    out.push(args[i]);
    i++;
  }
  return out;
}

function hasUnit(args: readonly string[], u: AutoFlagUnit): boolean {
  for (let i = 0; i < args.length; i++) if (unitMatchAt(args, i, u)) return true;
  return false;
}

/** The args with the provider's auto flag present exactly when `autoMode` is
 *  on. Args that already match are returned unchanged (same order). */
export function normalizeAutoFlagArgs(args: readonly string[], provider: AgentProvider, autoMode: boolean): string[] {
  const units = autoFlagUnits(provider);
  if (units.length === 0) return [...args];
  if (autoMode) {
    if (units.every((u) => hasUnit(args, u))) return [...args];
    const stripped = stripUnits(args, units);
    for (const u of units) { stripped.push(u.flag); if (u.value !== undefined) stripped.push(u.value); }
    return stripped;
  }
  return stripUnits(args, units);
}

/** Quote-aware split, the same rules as the renderer's `tokenizeCommand` and
 *  main's `tokenizeCommandLine`. */
function tokenize(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function quoteToken(t: string): string {
  return t === '' || /\s/.test(t) ? `"${t}"` : t;
}

/**
 * A command line with the provider's auto flag matching `autoMode` (finding 1).
 * Returns the input unchanged when it already matches, so an untouched line is
 * byte-identical. `provider` defaults to the one the binary names.
 */
export function normalizeAutoFlagCommand(command: string, autoMode: boolean, provider?: AgentProvider): string {
  const toks = tokenize(command.trim());
  if (toks.length === 0) return command;
  const [bin, ...args] = toks;
  const prov = provider ?? inferAgentProvider(command);
  const next = normalizeAutoFlagArgs(args, prov, autoMode);
  if (next.length === args.length && next.every((a, i) => a === args[i])) return command;
  return [bin, ...next].map(quoteToken).join(' ');
}

/**
 * Whether an argv carries any preset's auto (bypass) flag. The provider the
 * binary names counts in full; the other presets count by their long-form
 * flags only, so a short switch such as copilot's `-s` does not flag an
 * unrelated CLI. Used by main to refuse trusting such a line while auto mode
 * is off (finding 1b).
 */
export function argsHaveAutoFlag(args: readonly string[], provider: AgentProvider | undefined): boolean {
  for (const p of AGENT_PROVIDER_PRESETS) {
    for (const u of autoFlagUnits(p.id)) {
      if (p.id !== provider && !u.flag.startsWith('--')) continue;
      if (hasUnit(args, u)) return true;
    }
  }
  return false;
}
