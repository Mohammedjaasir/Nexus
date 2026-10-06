/**
 * Integrations registry + encrypted secret store (Phase 2 foundation, main process).
 *
 * Two responsibilities, deliberately separated from the broker:
 *   1. Registry — config-backed CRUD over IntegrationRecord metadata (NO secrets).
 *   2. Secret store — secrets ENCRYPTED AT REST via Electron `safeStorage`, kept in a
 *      file SEPARATE from config.json, decrypted only here, only in main.
 *
 * The broker (src/main/integrationBroker.ts) is electron-free and receives `getRecord`
 * + `getSecret` from here by injection, so it stays unit-testable without electron.
 *
 * SECURITY: a secret is never written unless `safeStorage.isEncryptionAvailable()`
 * (fail closed — no plaintext fallback), never returned to the renderer, never logged,
 * never placed in agent env/transcript, never echoed in any response. Records carry
 * only a `secretRef` handle.
 *
 * Contract: hive/docs/integrations-spec.md.
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type IntegrationRecord,
  validateIntegrationRecord,
  authTypeNeedsSecret,
  secretRefFor
} from '../shared/integrations';
import { readConfig, writeConfig } from './config';
import { writeFileAtomic } from './atomicWrite';

// ─── Registry (config-backed) ────────────────────────────────────────────────

/** All registered integration records (metadata only). */
export function listRecords(): IntegrationRecord[] {
  return readConfig().integrations ?? [];
}

/** Look up one record by id. */
export function getRecord(id: string): IntegrationRecord | undefined {
  return listRecords().find((r) => r.id === id);
}

/** Ids of integrations a worker may use right now (enabled, and — for secret auth —
 *  actually holding a stored secret). This is the default capability scope granted to
 *  every ephemeral worker. */
export function enabledIds(): string[] {
  return listRecords()
    .filter((r) => r.enabled && (!authTypeNeedsSecret(r.authType) || hasSecret(r.secretRef)))
    .map((r) => r.id);
}

/** Create or replace a record (validated). Stamps createdAt/updatedAt; preserves the
 *  original createdAt on update. Does NOT touch the secret store. */
export function upsertRecord(input: unknown): { ok: true; record: IntegrationRecord } | { ok: false; error: string } {
  const v = validateIntegrationRecord(input);
  if (!v.ok) return v;
  const now = Date.now();
  const existing = getRecord(v.value.id);
  const record: IntegrationRecord = {
    ...v.value,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const next = listRecords().filter((r) => r.id !== record.id);
  next.push(record);
  writeConfig({ integrations: next });
  return { ok: true, record };
}

/** Remove a record AND its stored secret. */
export function removeRecord(id: string): { ok: boolean } {
  const next = listRecords().filter((r) => r.id !== id);
  writeConfig({ integrations: next });
  deleteSecret(secretRefFor(id));
  return { ok: true };
}

/** Records with the secretRef redacted to a boolean — the renderer-safe shape. */
export function listRecordsRedacted(): Array<Omit<IntegrationRecord, 'secretRef'> & { hasSecret: boolean }> {
  return listRecords().map(({ secretRef, ...rest }) => ({ ...rest, hasSecret: !!secretRef && hasSecret(secretRef) }));
}

// ─── Secret store (encrypted at rest) ────────────────────────────────────────

function secretsPath(): string {
  return join(app.getPath('userData'), 'integration-secrets.json');
}

/** The secrets file, parsed. `corrupt` = it exists but is not a JSON object
 *  (reads then see no secrets; the file itself is never overwritten). */
function readSecretBlobState(): { blob: Record<string, string>; corrupt: boolean } {
  const p = secretsPath();
  if (!existsSync(p)) return { blob: {}, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { blob: parsed as Record<string, string>, corrupt: false };
    return { blob: {}, corrupt: true };
  } catch {
    return { blob: {}, corrupt: true };
  }
}

function readSecretBlob(): Record<string, string> {
  return readSecretBlobState().blob;
}

const CORRUPT_RE = /^integration-secrets\.corrupt-\d{14}(-\d+)?\.json$/;

/** Unreadable secrets files that were set aside (Settings shows a warning). */
export function corruptSecretFiles(): string[] {
  try {
    const dir = dirname(secretsPath());
    return readdirSync(dir).filter((f) => CORRUPT_RE.test(f)).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Before any write: an unreadable secrets file is moved aside as
 *  integration-secrets.corrupt-<yyyymmddHHMMss>.json, never overwritten. If it
 *  cannot be moved, this throws and the write is refused. */
function setAsideCorruptBlob(): void {
  const p = secretsPath();
  if (!readSecretBlobState().corrupt) return;
  const d = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  let dst = join(dirname(p), `integration-secrets.corrupt-${ts}.json`);
  for (let i = 1; existsSync(dst); i++) dst = join(dirname(p), `integration-secrets.corrupt-${ts}-${i}.json`);
  renameSync(p, dst);
  console.warn('[secrets] integration-secrets.json could not be read; it was set aside as', dst, 'and keys stored in it must be entered again');
}

function writeSecretBlob(blob: Record<string, string>): void {
  const p = secretsPath();
  mkdirSync(dirname(p), { recursive: true });
  setAsideCorruptBlob();
  // Atomic (temp + fsync + rename): this file now also holds the config
  // secrets (O.9 #8), so a torn write must never lose them. Same format.
  writeFileAtomic(p, JSON.stringify(blob, null, 2), undefined, { mode: 0o600 });
}

/** Whether OS secret encryption works on this system (main-only). */
export function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

/** Store a secret ENCRYPTED. Fail closed if OS encryption is unavailable (never
 *  writes plaintext). The plaintext is used only to encrypt and is not retained. */
export function setSecret(secretRef: string, plaintext: string): { ok: boolean; error?: string } {
  if (!secretRef) return { ok: false, error: 'secretRef required' };
  if (typeof plaintext !== 'string' || plaintext === '') return { ok: false, error: 'secret required' };
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secret encryption is unavailable; refusing to store a secret in plaintext' };
    }
    const cipher = safeStorage.encryptString(plaintext).toString('base64');
    const blob = readSecretBlob();
    blob[secretRef] = cipher;
    writeSecretBlob(blob);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Decrypt a secret. MAIN-INTERNAL ONLY — never expose this over IPC. Returns
 *  undefined if absent or undecryptable (the broker maps that to 503 no_secret). */
export function getSecret(secretRef: string | undefined): string | undefined {
  if (!secretRef) return undefined;
  const cipher = readSecretBlob()[secretRef];
  if (!cipher) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
  } catch {
    return undefined;
  }
}

/** Whether a secret is stored for this ref (no decryption). */
export function hasSecret(secretRef: string | undefined): boolean {
  if (!secretRef) return false;
  return !!readSecretBlob()[secretRef];
}

/** Delete a stored secret. Idempotent. */
export function deleteSecret(secretRef: string | undefined): void {
  if (!secretRef) return;
  const blob = readSecretBlob();
  if (secretRef in blob) {
    delete blob[secretRef];
    if (Object.keys(blob).length === 0) {
      try { rmSync(secretsPath(), { force: true }); } catch { /* best-effort */ }
    } else {
      writeSecretBlob(blob);
    }
  }
}
