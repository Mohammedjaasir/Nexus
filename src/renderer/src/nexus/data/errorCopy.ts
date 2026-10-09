// Pure: the plain sentence a person sees for a nexus:* failure, and whether
// trying again can help. No raw code or reason ever reaches the screen.
import type { NexusErrorCode } from '@shared/nexus/ipc';

export interface ErrorCopy {
  text: string;
  /** True when the same request may succeed if sent again (a held lock, an unexpected failure). */
  retry: boolean;
  /**
   * - unavailable: the platform is off; screens fall back to the domain grouping and hide writes.
   * - handoffs_unavailable: only handoffs are off.
   * - busy / internal: a passing failure; show "try again", never the degraded mode.
   * - refused: the request itself was refused.
   */
  kind: 'unavailable' | 'handoffs_unavailable' | 'busy' | 'internal' | 'refused';
}

/** Every error code a nexus:* channel can answer with. */
export const NEXUS_ERROR_CODES: readonly NexusErrorCode[] = Object.freeze([
  'denied', 'not_found', 'invalid', 'conflict', 'immutable', 'cycle', 'not_owner', 'not_participating',
  'participation_inactive', 'input_not_granted', 'storage_unavailable', 'illegal_transition', 'platform_unavailable', 'unavailable', 'internal'
] as NexusErrorCode[]);

const CODE_TEXT: Record<NexusErrorCode, string> = {
  denied: 'You do not have permission to do that here.',
  not_found: 'That item no longer exists. It may have been removed.',
  invalid: 'That request could not be accepted. Check the values and send it again.',
  conflict: 'Something changed in the meantime, so nothing was saved. Reload and try again.',
  immutable: 'That record is final and cannot be changed.',
  cycle: 'That link would make a version depend on itself, so it was not added.',
  not_owner: 'Only the workspace that owns this artifact can change it.',
  not_participating: 'This project does not take part in that workspace.',
  participation_inactive: 'This project no longer takes part in that workspace, so it cannot take new work there.',
  input_not_granted: 'That version is not available as an input here.',
  storage_unavailable: 'The stored content could not be read.',
  illegal_transition: 'That step is not possible from the current status.',
  platform_unavailable: 'Workspace data is not available right now.',
  unavailable: 'That cannot run on this computer right now. Check the setup notes for what it needs.',
  internal: 'The request could not be completed. Try again.'
};

/** Why the whole platform is off (the reason of a platform_unavailable answer). */
const UNAVAILABLE_WHY: Record<string, string> = {
  held: 'the database upgrade is held',
  migration_failed: 'the database upgrade did not complete',
  newer_schema: 'the database was upgraded by a newer version of the app',
  shape_mismatch: 'the database does not have the expected layout',
  startup_failed: 'the workspace database could not be read',
  not_open: 'the database is not open'
};
export const UNAVAILABLE_REASONS: readonly string[] = Object.freeze(Object.keys(UNAVAILABLE_WHY));

/** Why handoffs alone are off (the sub-reason of handoffs_unavailable). */
const HANDOFFS_WHY: Record<string, string> = {
  held: 'the database upgrade that adds them is held',
  auto_held: 'the database upgrade that adds them was held after an earlier problem',
  backup_failed: 'the backup before the database upgrade that adds them failed',
  failed: 'the database upgrade that adds them did not complete',
  shape: 'the handoff tables do not have the expected layout'
};
export const HANDOFFS_SUB_REASONS: readonly string[] = Object.freeze(Object.keys(HANDOFFS_WHY));

/** Service reasons a refusal may carry, with a sentence a person can act on. */
/** The sentence per service reason. Every key main also words (REASON_MESSAGES in nexusIpc/envelope.ts) reads the same. */
export const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  bad_request: 'That request could not be accepted. Check the values and send it again.',
  not_a_repository: 'The project folder is not a git repository.',
  not_a_commit: 'That commit was not found in the project repository.',
  project_folder_unavailable: 'The project folder is not available, so nothing was read.',
  kind_mismatch: 'That artifact holds a different kind of content.',
  secret_in_metadata: 'The name or details look like they hold a secret, so nothing was saved.',
  file_not_found: 'That file was not found in the project folder.',
  path_refused: 'That file cannot be saved. Paths outside the project folder are refused, and so are files with several '
    + 'hard links (as pnpm stores and some backup tools create them).',
  too_large: 'That file is too large to save as an artifact.',
  not_text: 'That file is not plain text, so it cannot be saved as a text artifact.',
  secret_in_content: 'That file looks like it holds a secret, so it was not saved.',
  sensitive_name: 'Files of that kind (keys, credentials, environment files, anything under .git) are never saved.',
  produced_by_job: 'A draft made by a job or an agent session is finished by the engine, not marked ready by hand.'
});
export const SERVICE_REASONS: readonly string[] = Object.freeze(Object.keys(REASON_TEXT));

export const BUSY_TEXT = 'The database is busy. Try again in a moment.';

/** The notice shown while screens fall back to the domain grouping. */
export function unavailableNotice(reason: string | null | undefined): string {
  const why = reason ? UNAVAILABLE_WHY[reason] : undefined;
  return why
    ? `Workspace data is not available because ${why}. Projects are grouped by their detected domain until it runs.`
    : 'Workspace data is not available. Projects are grouped by their detected domain until it is available.';
}

/** The note shown where handoffs would be. */
export function handoffsNotice(subReason: string | null | undefined): string {
  const why = subReason ? HANDOFFS_WHY[subReason] : undefined;
  return why ? `Handoffs are not available because ${why}.` : 'Handoffs are not available on this database.';
}

export function errorCopy(code: string, reason?: string | null, subReason?: string | null): ErrorCopy {
  if (code === 'platform_unavailable') {
    if (reason === 'busy') return { text: BUSY_TEXT, retry: true, kind: 'busy' };
    if (reason === 'handoffs_unavailable') return { text: handoffsNotice(subReason), retry: false, kind: 'handoffs_unavailable' };
    return { text: unavailableNotice(reason), retry: false, kind: 'unavailable' };
  }
  if (code === 'internal') return { text: CODE_TEXT.internal, retry: true, kind: 'internal' };
  const byReason = reason ? REASON_TEXT[reason] : undefined;
  const byCode = Object.prototype.hasOwnProperty.call(CODE_TEXT, code) ? CODE_TEXT[code as NexusErrorCode] : undefined;
  return { text: byReason ?? byCode ?? 'The request was refused.', retry: false, kind: 'refused' };
}
