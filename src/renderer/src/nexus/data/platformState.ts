// Pure: how the platform view changes when a nexus:participations:list answer
// arrives. No zustand, no React, so tests load it directly.
import type { NexusResult, ParticipationView } from '@shared/nexus/ipc';
import { fromRows, type ParticipationIndex, type ParticipationRow } from '../workspaces/participation';
import { errorCopy } from './errorCopy';

export interface PlatformView {
  /**
   * 'db' once participations were read from the database. 'legacy' before the first answer and while the
   * platform is unavailable: screens then group projects by detected domain and show no write action.
   */
  mode: 'db' | 'legacy';
  /** The database index; null until the first successful read, and again while the platform is unavailable. */
  participations: ParticipationIndex | null;
  /** Set while the platform is unavailable (the reason main gave, when it gave one). */
  unavailable: { reason: string | null } | null;
  /** A passing failure (a busy database, an unexpected error): "try again", never the degraded mode. */
  retry: { text: string } | null;
}

export const INITIAL_PLATFORM_VIEW: PlatformView = { mode: 'legacy', participations: null, unavailable: null, retry: null };

const toRow = (v: ParticipationView): ParticipationRow => ({
  id: v.id, projectId: v.projectId, workspaceId: v.workspaceId, status: v.status, isPrimary: v.isPrimary, source: v.source
});

/** The next view after a participations-list answer. */
export function nextPlatformState(prev: PlatformView, r: NexusResult<ParticipationView[]>): PlatformView {
  if (r.ok) {
    return { mode: 'db', participations: fromRows(Array.isArray(r.data) ? r.data.map(toRow) : []), unavailable: null, retry: null };
  }
  const copy = errorCopy(r.code, r.reason, r.subReason);
  if (copy.kind === 'unavailable') {
    return { mode: 'legacy', participations: null, unavailable: { reason: r.reason ?? null }, retry: null };
  }
  // Busy keeps its own sentence. Anything else this channel should never answer (a refusal, handoffs off)
  // is shown like an unexpected failure. Either way, keep what was last read and offer to try again.
  const text = copy.kind === 'busy' ? copy.text : errorCopy('internal').text;
  return { ...prev, retry: { text } };
}

/** Platform write actions render only while the database is the authority. */
export const canWrite = (s: Pick<PlatformView, 'mode' | 'unavailable'>): boolean => s.mode === 'db' && s.unavailable === null;
