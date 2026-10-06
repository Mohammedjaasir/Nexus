import { useEffect } from 'react';
import { create } from 'zustand';
import { autoModeNeedsReview } from '@shared/autoModeReview';
import type { HarnessConfig } from '@/store/config';

/**
 * O.9 #10: the one-time "Auto mode is on" review for existing installs. One
 * shared state, so answering on the Agents page also clears Settings → Autonomy
 * (and the other way round). Read fresh from main on first use: App's config
 * prop is loaded once and is not refreshed after Settings writes.
 *
 * The banner never changes auto mode by itself; only the user's click does.
 */
interface ReviewState {
  needs: boolean | null;
  busy: boolean;
  error: string;
  patch: (p: Partial<Omit<ReviewState, 'patch'>>) => void;
}

const useReviewStore = create<ReviewState>((set) => ({
  needs: null,
  busy: false,
  error: '',
  patch: (p) => set(p)
}));

/** Re-derive the banner from a config main just returned (e.g. after the
 *  Settings auto mode toggle). */
export function syncAutoModeReview(cfg: Pick<HarnessConfig, 'autoMode' | 'autoModeReviewedV1'>): void {
  useReviewStore.getState().patch({ needs: autoModeNeedsReview(cfg) });
}

export function useAutoModeReview(): {
  needs: boolean;
  busy: boolean;
  error: string;
  turnOff: () => Promise<HarnessConfig | undefined>;
  keep: () => Promise<HarnessConfig | undefined>;
} {
  const needs = useReviewStore((s) => s.needs);
  const busy = useReviewStore((s) => s.busy);
  const error = useReviewStore((s) => s.error);
  const patch = useReviewStore((s) => s.patch);

  useEffect(() => {
    if (needs !== null) return;
    let alive = true;
    window.cth.getConfig()
      .then((c) => { if (alive) patch({ needs: autoModeNeedsReview(c) }); })
      .catch(() => { /* no banner without a config read */ });
    return () => { alive = false; };
  }, [needs, patch]);

  const answer = async (turnOff: boolean): Promise<HarnessConfig | undefined> => {
    patch({ busy: true, error: '' });
    try {
      const next = await window.cth.updateConfig(
        turnOff ? { autoMode: false, autoModeReviewedV1: true } : { autoModeReviewedV1: true }
      );
      patch({ needs: autoModeNeedsReview(next), busy: false });
      return next as HarnessConfig;
    } catch {
      patch({ busy: false, error: 'Could not save your choice. Try again.' });
      return undefined;
    }
  };

  return { needs: needs === true, busy, error, turnOff: () => answer(true), keep: () => answer(false) };
}
