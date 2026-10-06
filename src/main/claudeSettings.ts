import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomicWrite';

/**
 * O.9 #9: older builds wrote two keys into the user's GLOBAL Claude settings
 * (`~/.claude/settings.json`) so agents in bypass mode would not stall on
 * Claude's warning. Nexus no longer does that (the keys ride in each agent's
 * own `--settings` file). This undoes the old write, only when the user asks
 * (Settings → Agents & Models → "Restore my Claude settings", behind a main
 * dialog): it removes exactly these two keys, keeps a backup next to the file,
 * and changes nothing else.
 */
export const NEXUS_CLAUDE_KEYS = ['skipDangerousModePermissionPrompt', 'skipAutoPermissionPrompt'] as const;

function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Read-only: which of the two keys are in the user's global Claude settings
 *  now (so Settings can say "Nothing to remove." without a dialog). */
export function claudeSettingsKeysPresent(home: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    return NEXUS_CLAUDE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(parsed, k));
  } catch {
    return [];
  }
}

export function restoreClaudeSettings(home: string): { ok: true; removed: string[]; backup?: string } | { ok: false; error: string } {
  if (!home) return { ok: false, error: 'no home folder' };
  const file = join(home, '.claude', 'settings.json');
  if (!existsSync(file)) return { ok: true, removed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: `settings.json is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'settings.json is not a JSON object' };
  const settings = parsed as Record<string, unknown>;
  const removed = NEXUS_CLAUDE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(settings, k));
  if (removed.length === 0) return { ok: true, removed: [] };
  try {
    let backup = `${file}.nexus-backup-${stamp()}`;
    for (let i = 1; existsSync(backup); i++) backup = `${file}.nexus-backup-${stamp()}-${i}`;
    copyFileSync(file, backup);
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(settings)) if (!(NEXUS_CLAUDE_KEYS as readonly string[]).includes(k)) next[k] = v;
    writeFileAtomic(file, JSON.stringify(next, null, 2));
    return { ok: true, removed: [...removed], backup };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
