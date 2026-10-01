import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '@/store/store';

interface LoadState { status: 'loading' | 'ready' | 'error'; error: string | null; set: (p: Partial<LoadState>) => void }
const useLoad = create<LoadState>((set) => ({ status: 'loading', error: null, set: (p) => set(p) }));

let inflight: Promise<void> | null = null;

async function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    useLoad.getState().set({ status: useStore.getState().projects.length ? 'ready' : 'loading', error: null });
    try {
      const list = await window.cth.projectList();
      useStore.getState().setProjects(Array.isArray(list) ? list : []);
      useLoad.getState().set({ status: 'ready', error: null });
    } catch (e) {
      useLoad.getState().set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Loads the real project list once per mount and exposes status + refresh. */
export function useProjectsLoader() {
  const status = useLoad((s) => s.status);
  const error = useLoad((s) => s.error);
  useEffect(() => { void load(); }, []);
  const refresh = useCallback(() => load(), []);
  return { status, error, refresh };
}
