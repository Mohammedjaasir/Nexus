// The renderer's view of the Nexus platform: the participation index read from
// the database, whether screens are in the labelled legacy fallback, and a
// revision bumped after every platform mutation so readers refresh.
import { create } from 'zustand';
import type { NexusResult, ParticipationView } from '@shared/nexus/ipc';
import { fromRows, type ParticipationIndex, type ParticipationRow } from '../workspaces/participation';
import { errorCopy } from './errorCopy';

export interface PlatformState {
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
  /** False once a handoff channel answered handoffs_unavailable; null while unknown. Affects handoff UI only. */
  handoffsAvailable: boolean | null;
  handoffsSubReason: string | null;
  /** Bumped after every platform mutation; readers reload on change. */
  rev: number;
  bumpRev: () => void;
  applyParticipations: (r: NexusResult<ParticipationView[]>) => void;
  /** Record what any nexus:* answer says about handoffs. */
  noteHandoffs: (r: NexusResult<unknown>) => void;
}

const toRow = (v: ParticipationView): ParticipationRow => ({
  id: v.id, projectId: v.projectId, workspaceId: v.workspaceId, status: v.status, isPrimary: v.isPrimary, source: v.source
});

export const usePlatform = create<PlatformState>((set) => ({
  mode: 'legacy',
  participations: null,
  unavailable: null,
  retry: null,
  handoffsAvailable: null,
  handoffsSubReason: null,
  rev: 0,
  bumpRev: () => set((s) => ({ rev: s.rev + 1 })),
  applyParticipations: (r) => {
    if (r.ok) {
      set({ mode: 'db', participations: fromRows(Array.isArray(r.data) ? r.data.map(toRow) : []), unavailable: null, retry: null });
      return;
    }
    const copy = errorCopy(r.code, r.reason, r.subReason);
    if (copy.kind === 'unavailable') {
      set({ mode: 'legacy', participations: null, unavailable: { reason: r.reason ?? null }, retry: null });
      return;
    }
    // Busy, internal or an unexpected refusal: keep what was last read and offer to try again.
    set({ retry: { text: copy.text } });
  },
  noteHandoffs: (r) => {
    if (!r.ok && r.code === 'platform_unavailable' && r.reason === 'handoffs_unavailable') {
      set({ handoffsAvailable: false, handoffsSubReason: r.subReason ?? null });
    }
  }
}));

/** Platform write actions render only while the database is the authority. */
export const selectCanWrite = (s: PlatformState): boolean => s.mode === 'db' && s.unavailable === null;
