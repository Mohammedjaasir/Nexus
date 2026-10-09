/**
 * `blob.integrity` v1 (build, candidate, blocking; executed by the runner's `blob.verify` re-hash). Pure over
 * the answers main collected: every stored object of the version re-hashed to its name. A version with no
 * stored object has nothing to verify and fails; an object the runner could not verify (a fault, no answer)
 * makes the check `error`, never `passed`.
 */
import { errored, failed, passed, type ValidatorOutcome } from '../normalized';

export const ID = 'blob.integrity';
export const VERSION = '1';

export type VerifyAnswer = 'ok' | 'mismatch' | 'fault' | 'no_answer';

export function run(f: { objects: readonly string[]; answers: Readonly<Record<string, VerifyAnswer>> }): ValidatorOutcome {
  const ev = f.objects.slice(0, 200).map((sha) => ({ type: 'hash' as const, label: `object:${f.answers[sha] ?? 'no_answer'}`, sha256: sha }));
  if (f.objects.length === 0) return failed('no_objects', 'The version stores no object to verify.', ev);
  const bad = f.objects.filter((s) => f.answers[s] === 'mismatch');
  if (bad.length > 0) return failed('rehash_failed', `${bad.length} stored object(s) are missing or changed on disk.`, ev);
  const unknown = f.objects.filter((s) => f.answers[s] !== 'ok');
  if (unknown.length > 0) return errored('could_not_verify', `Checks could not run: ${unknown.length} object(s) could not be verified.`, ev);
  return passed(`${f.objects.length} stored object(s) re-hashed to their names.`, ev);
}
