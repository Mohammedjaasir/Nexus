import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';
import { deliveryTargets } from './workbenchModel';

// One flag for every mounted workbench. The docked and the fullscreen lead
// workbench are mounted at the same time; each used to keep its own copy,
// seeded only on mount, so a toggle in one left the other showing stale state.
let pausedFlag = false;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void): (() => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
const snapshot = (): boolean => pausedFlag;
function setPausedFlag(v: boolean): void {
  if (v === pausedFlag) return;
  pausedFlag = v;
  for (const l of listeners) l();
}

/** One auto-delivery switch for every agent's queue, lead included. Seeded from
 *  the lead agent's own control state: this single control keeps every agent in
 *  step, so the lead's state stands for all of them. Re-seeded whenever the
 *  fullscreen view opens or closes. `leadId` null: not the lead's workbench,
 *  nothing to seed. */
export function useDeliveryControl(leadId: string | null): { paused: boolean; toggle: () => Promise<void> } {
  const paused = useSyncExternalStore(subscribe, snapshot, snapshot);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  useEffect(() => {
    if (!leadId) return;
    let alive = true;
    window.cth.controlSnapshot(leadId)
      .then((s) => { if (alive && s) setPausedFlag(s.autoDeliveryPaused); })
      .catch(() => { /* none */ });
    return () => { alive = false; };
  }, [leadId, fullscreenAgentId]);
  const toggle = async (): Promise<void> => {
    const next = !pausedFlag;
    setPausedFlag(next);
    await Promise.all(deliveryTargets(useStore.getState().agents).map((id) => window.cth.controlAutoDelivery(id, next).catch(() => null)));
  };
  return { paused, toggle };
}
