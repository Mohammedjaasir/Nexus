// The renderer's view of the Nexus platform: the participation index read from
// the database, whether screens are in the labelled legacy fallback, and a
// revision bumped after every platform mutation so readers refresh. The
// transitions themselves live in platformState.ts (pure).
import { create } from 'zustand';
import type { NexusResult, ParticipationView } from '@shared/nexus/ipc';
import { INITIAL_PLATFORM_VIEW, canWrite, nextPlatformState, type PlatformView } from './platformState';

export interface PlatformState extends PlatformView {
  /** False once a handoff channel answered handoffs_unavailable; null while unknown. Affects handoff UI only. */
  handoffsAvailable: boolean | null;
  handoffsSubReason: string | null;
  /** Bumped after every platform mutation; readers reload on change. */
  rev: number;
  bumpRev: () => void;
  applyParticipations: (r: NexusResult<ParticipationView[]>) => void;
  /** Record what a handoff channel's answer says: a success means handoffs are on; handoffs_unavailable means off. */
  noteHandoffs: (r: NexusResult<unknown>) => void;
}

export const usePlatform = create<PlatformState>((set, get) => ({
  ...INITIAL_PLATFORM_VIEW,
  handoffsAvailable: null,
  handoffsSubReason: null,
  rev: 0,
  bumpRev: () => set((s) => ({ rev: s.rev + 1 })),
  applyParticipations: (r) => {
    const s = get();
    const next = nextPlatformState({ mode: s.mode, participations: s.participations, unavailable: s.unavailable, retry: s.retry }, r);
    set(next);
  },
  noteHandoffs: (r) => {
    if (r.ok) {
      if (get().handoffsAvailable !== true) set({ handoffsAvailable: true, handoffsSubReason: null });
    } else if (r.code === 'platform_unavailable' && r.reason === 'handoffs_unavailable') {
      set({ handoffsAvailable: false, handoffsSubReason: r.subReason ?? null });
    }
  }
}));

/** Platform write actions render only while the database is the authority. */
export const selectCanWrite = (s: PlatformState): boolean => canWrite(s);
