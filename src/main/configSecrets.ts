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
