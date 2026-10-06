import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { HarnessConfig } from './config';
import type { SecretField } from './configPolicy';

/**
 * Config secrets in safeStorage (O.9 #8). Pure: the encrypted store, the backup
 * and the config write are injected, so every path is unit-tested with a fake
 * store (test/nexus-config-hardening.test.cjs).
 *
 * Refs live in integrations.ts's encrypted file next to the integration and
 * provider keys, with their own `config:` prefix so they never collide.
 */

export const SECRET_FIELDS: readonly SecretField[] = ['slackSigningSecret', 'slackBotToken', 'groqApiKey', 'webhookSecret'];
export const ORG_API_KEY_REF = 'config:org:apiKey';

export function secretRef(field: SecretField): string {
  return `config:${field}`;
}

export function webhookSecretRef(id: string): string {
  return `config:webhook:${id}`;
}

export type RedactedConfig = HarnessConfig & { secretsPresent: Record<SecretField | 'orgApiKey', boolean> };

function present(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * The renderer-safe config: every secret value is removed and replaced by a
 * boolean. A secret counts as present when it is in the encrypted store OR
 * still in plaintext (before the migration, or without secure storage).
 */
export function redactConfig(cfg: HarnessConfig, hasSecret: (ref: string) => boolean): RedactedConfig {
  const out: Record<string, unknown> = { ...cfg };
  const secretsPresent = {} as Record<SecretField | 'orgApiKey', boolean>;
  for (const f of SECRET_FIELDS) {
    secretsPresent[f] = present(cfg[f]) || hasSecret(secretRef(f));
    delete out[f];
  }
  if (Array.isArray(cfg.webhookTriggers)) {
    out.webhookTriggers = cfg.webhookTriggers.map((t) => ({
      ...t,
      secret: '',
      hasSecret: present(t.secret) || hasSecret(webhookSecretRef(t.id))
    }));
  }
  const org = cfg.orgTrigger;
  secretsPresent.orgApiKey = present(org?.apiKey) || hasSecret(ORG_API_KEY_REF);
  if (org) out.orgTrigger = { ...org, apiKey: '', hasApiKey: secretsPresent.orgApiKey };
  return { ...(out as unknown as HarnessConfig), secretsPresent };
}

/** Which plaintext secrets to move, and the config without them. */
export function planSecretMigration(cfg: HarnessConfig): { moves: Array<{ ref: string; value: string }>; stripped: HarnessConfig } {
  const moves: Array<{ ref: string; value: string }> = [];
  const stripped: Record<string, unknown> = { ...cfg, secretsMigratedV1: true };
  for (const f of SECRET_FIELDS) {
    const v = cfg[f];
    if (present(v)) moves.push({ ref: secretRef(f), value: v });
    delete stripped[f];
  }
  if (Array.isArray(cfg.webhookTriggers)) {
    stripped.webhookTriggers = cfg.webhookTriggers.map((t) => {
      if (present(t.secret)) moves.push({ ref: webhookSecretRef(t.id), value: t.secret });
      return { ...t, secret: '' };
    });
  }
  if (cfg.orgTrigger) {
    if (present(cfg.orgTrigger.apiKey)) moves.push({ ref: ORG_API_KEY_REF, value: cfg.orgTrigger.apiKey });
    stripped.orgTrigger = { ...cfg.orgTrigger, apiKey: '' };
  }
  return { moves, stripped: stripped as unknown as HarnessConfig };
}

export interface MigrationDeps {
  encryptionAvailable(): boolean;
  /** Copy config.json next to itself; returns the backup path. */
  backup(): string;
  setSecret(ref: string, v: string): { ok: boolean; error?: string };
  getSecret(ref: string): string | undefined;
  write(next: HarnessConfig): void;
}

export type MigrationResult = {
  status: 'nothing' | 'migrated' | 'encryption-unavailable' | 'verify-failed' | 'error';
  backup?: string;
  error?: string;
};

/**
 * Move every plaintext secret into the encrypted store, never losing one:
 *   1. nothing to move → 'nothing' (no backup, no write);
 *   2. no secure storage → 'encryption-unavailable' (no backup, no write: the
 *      plaintext stays and every reader keeps working from it);
 *   3. back up config.json (a failed backup stops here);
 *   4. store every secret, then read every one back and compare;
 *   5. only when all of them verify, write the config without the plaintext.
 * Any failure before step 5 leaves config.json exactly as it was. Secrets
 * already stored by a failed run are harmless: they hold the same values.
 */
export function migrateConfigSecrets(cfg: HarnessConfig, deps: MigrationDeps): MigrationResult {
  const { moves, stripped } = planSecretMigration(cfg);
  if (moves.length === 0) return { status: 'nothing' };
  let backup: string;
  try {
    if (!deps.encryptionAvailable()) return { status: 'encryption-unavailable' };
    backup = deps.backup();
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  try {
    for (const m of moves) {
      const r = deps.setSecret(m.ref, m.value);
      if (!r.ok) return { status: 'error', backup, error: r.error ?? `could not store ${m.ref}` };
    }
    for (const m of moves) {
      if (deps.getSecret(m.ref) !== m.value) return { status: 'verify-failed', backup, error: `${m.ref} did not read back` };
    }
    deps.write(stripped);
    return { status: 'migrated', backup };
  } catch (e) {
    return { status: 'error', backup, error: e instanceof Error ? e.message : String(e) };
  }
}

/** How one secret write ended. */
export type StoreOutcome = { kind: 'stored' } | { kind: 'plaintext' } | { kind: 'error'; error: string };

/**
 * Store one config secret (Task 12 review). Plaintext is used ONLY when this
 * system has no secure storage at all; then any older encrypted copy is dropped
 * so it cannot shadow the newer plaintext. Any other store failure (disk,
 * unreadable secrets file, …) refuses the write: the caller keeps whatever was
 * stored before, encrypted copy included, and reports the error.
 */
export function decideSecretStore(
  deps: { encryptionAvailable(): boolean; setSecret(ref: string, v: string): { ok: boolean; error?: string }; deleteSecret(ref: string): void },
  ref: string,
  value: string
): StoreOutcome {
  if (!deps.encryptionAvailable()) {
    try { deps.deleteSecret(ref); } catch { /* best-effort */ }
    return { kind: 'plaintext' };
  }
  const r = deps.setSecret(ref, value);
  if (r.ok) return { kind: 'stored' };
  return { kind: 'error', error: r.error ?? 'could not store the secret' };
}

const BACKUP_RE = /^config\.pre-secrets-\d{14}(-\d+)?\.json$/;

/** The config.pre-secrets-*.json backups in `dir` (they hold plaintext secrets). */
export function listConfigBackups(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Copy config.json to config.pre-secrets-<yyyymmddHHMMss>.json next to it,
 * unless a backup with identical content already exists (a migration that
 * keeps failing must not pile up plaintext copies). Returns the backup path.
 */
export function writeConfigBackup(src: string, now: Date = new Date()): string {
  const dir = dirname(src);
  const content = readFileSync(src);
  for (const existing of listConfigBackups(dir)) {
    try { if (readFileSync(existing).equals(content)) return existing; } catch { /* unreadable: ignore */ }
  }
  const ts = stamp(now);
  let dst = join(dir, `config.pre-secrets-${ts}.json`);
  for (let i = 1; listConfigBackups(dir).map((f) => basename(f)).includes(basename(dst)); i++) dst = join(dir, `config.pre-secrets-${ts}-${i}.json`);
  writeFileSync(dst, content, { flag: 'wx' });
  return dst;
}
