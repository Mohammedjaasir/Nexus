/**
 * `sde.deps.lock_matches` v1 (repository, ADVISORY; run by main at the ingest of a dependency install, B2a Task 13 fix
 * round 1). Pure. An install (`sde.deps.node`, `sde.deps.python`) is never complete on its exit code alone: its one
 * contract output `lock.sha256` must prove that the locked list the approval named is the list that was installed.
 * - a non-zero exit (or an OOM kill)                       -> failed `nonzero_exit`
 * - no `lock.sha256` among the outputs                      -> failed `missing_output`
 * - any other output beside it                              -> failed `extra_output`
 * - the stored bytes could not be read back, or their sha256 is not the staged one -> failed `lock_unreadable`
 * - not 64 lowercase hex characters (one trailing newline allowed): a secret-shaped value -> failed `secret_in_output`,
 *   anything else -> failed `not_hex` (the content is never echoed)
 * - not the repository version's `metadata.lockfile.sha256` -> failed `repository_mismatch`
 * - no approval consumed by THIS attempt, or not its `lockfileSha256` -> failed `approval_missing` / `approval_mismatch`
 * Passed: typed evidence (the exit, the stored output's hash, the matched lockfile hash).
 */
import type { Evidence } from '../../../../shared/nexus/evidence';
import { containsSecret } from '../../activity/redact';
import { failed, passed, SHA256_RE, type ValidatorOutcome } from '../normalized';

export const ID = 'sde.deps.lock_matches';
export const VERSION = '1';
/** The one contract output of an install. */
export const LOCK_OUTPUT = 'lock.sha256';
/** 64 hex characters and a line ending at most: anything larger is not a lockfile hash. */
export const LOCK_OUTPUT_MAX_BYTES = 66;

export interface DepsLockFacts {
  exit: { code: number | null; signal?: string; oomKilled: boolean };
  /** Every output the attempt staged. */
  outputs: { relPath: string; sha256: string; bytes: number }[];
  /** `lock.sha256` as main read it back from the blob store (its sha256 re-checked), or why it could not be. */
  read: { text: string } | { error: string } | null;
  /** The input repository version's `metadata.lockfile.sha256`. */
  repositoryLock: string | null;
  /** The `lockfileSha256` of the approval consumed by this job's attempt n (null: none was). */
  approvalLock: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function run(f: DepsLockFacts): ValidatorOutcome {
  if (!isObj(f) || !isObj(f.exit) || !Array.isArray(f.outputs)) return failed('lock_unreadable', 'The install facts were not usable.');
  const exitEv: Evidence = { type: 'exit', code: f.exit.code, ...(f.exit.signal ? { signal: f.exit.signal } : {}), oomKilled: f.exit.oomKilled === true };
  if (f.exit.code !== 0 || f.exit.oomKilled === true) return failed('nonzero_exit', 'The install did not exit 0.', [exitEv]);
  const staged = f.outputs.filter((o) => isObj(o) && o.relPath === LOCK_OUTPUT);
  if (staged.length !== 1) return failed('missing_output', `The install wrote no ${LOCK_OUTPUT}.`, [exitEv]);
  if (f.outputs.length !== 1) return failed('extra_output', `The install wrote outputs other than ${LOCK_OUTPUT}.`, [exitEv]);
  const out = staged[0];
  if (typeof out.sha256 !== 'string' || !SHA256_RE.test(out.sha256)) return failed('lock_unreadable', `${LOCK_OUTPUT} has no stored hash.`, [exitEv]);
  const outEv: Evidence = { type: 'hash', label: LOCK_OUTPUT, sha256: out.sha256 };
  if (!(Number.isSafeInteger(out.bytes) && out.bytes >= 0 && out.bytes <= LOCK_OUTPUT_MAX_BYTES)) {
    return failed('not_hex', `${LOCK_OUTPUT} is not a lockfile hash.`, [exitEv, outEv]);
  }
  const raw = isObj(f.read) && typeof (f.read as { text?: unknown }).text === 'string' ? (f.read as { text: string }).text : null;
  if (raw === null) return failed('lock_unreadable', `${LOCK_OUTPUT} could not be read back from the blob store.`, [exitEv, outEv]);
  const text = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!SHA256_RE.test(text)) {
    return containsSecret(raw)
      ? failed('secret_in_output', `${LOCK_OUTPUT} holds a secret-shaped value; nothing was stored.`, [exitEv, outEv])
      : failed('not_hex', `${LOCK_OUTPUT} does not hold 64 lowercase hex characters.`, [exitEv, outEv]);
  }
  const lockEv: Evidence = { type: 'hash', label: 'lockfile', sha256: text };
  const repo = typeof f.repositoryLock === 'string' && SHA256_RE.test(f.repositoryLock) ? f.repositoryLock : null;
  if (repo !== text) return failed('repository_mismatch', 'The installed lockfile hash is not the repository version\'s lockfile hash.', [exitEv, outEv, lockEv]);
  if (typeof f.approvalLock !== 'string' || !SHA256_RE.test(f.approvalLock)) {
    return failed('approval_missing', 'No approval was consumed by this attempt.', [exitEv, outEv, lockEv]);
  }
  if (f.approvalLock !== text) return failed('approval_mismatch', 'The installed lockfile hash is not the one the approval named.', [exitEv, outEv, lockEv]);
  return passed(`The installed list matches the approved lockfile (${text.slice(0, 12)}).`, [exitEv, outEv, lockEv]);
}
