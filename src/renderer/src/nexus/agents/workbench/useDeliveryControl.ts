import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { deliveryTargets } from './workbenchModel';

/** One auto-delivery switch for every agent's queue, lead included. Seeded from
 *  the lead agent's own control state: this single control keeps every agent in
 *  step, so the lead's state stands for all of them. Moved from the old lead
 *  panel unchanged. `leadId` null: not the lead's workbench, nothing to seed. */
export function useDeliveryControl(leadId: string | null): { paused: boolean; toggle: () => Promise<void> } {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!leadId) return;
    let alive = true;
    window.cth.controlSnapshot(leadId)
      .then((s) => { if (alive && s) setPaused(s.autoDeliveryPaused); })
      .catch(() => { /* none */ });
    return () => { alive = false; };
  }, [leadId]);
  const toggle = async (): Promise<void> => {
    const next = !paused;
    setPaused(next);
    await Promise.all(deliveryTargets(useStore.getState().agents).map((id) => window.cth.controlAutoDelivery(id, next).catch(() => null)));
  };
  return { paused, toggle };
}
