import { useMemo } from 'react';
import { useStore } from '@/store/store';
import { useNexusUi, type SentRequest } from '../state/uiStore';
import { runsFor, type RunView } from './runModel';

export type RunEntry = { request: SentRequest; run: RunView };

/** Every request sent from the intent line this session, paired with its run
 *  as derived from the real queue, acknowledged deliveries and agent records.
 *  Oldest first. */
export function useRuns(): RunEntry[] {
  const requests = useNexusUi((s) => s.requests);
  const agents = useStore((s) => s.agents);
  const queues = useStore((s) => s.messageQueues);
  const deliveredIds = useStore((s) => s.deliveredIds);
  const lastDelivered = useStore((s) => s.lastDelivered);
  return useMemo(() => {
    const ids = new Set(requests.map((r) => r.agentId));
    const relevant = agents.filter((a) => ids.has(a.id)).map((a) => ({
      id: a.id, status: a.status, running: !!a.ptyId, blocked: a.status === 'blocked' && !!a.blockReason
    }));
    const runs = runsFor(requests, relevant, queues, { deliveredIds, lastDelivered });
    return requests.map((request, i) => ({ request, run: runs[i] }));
  }, [requests, agents, queues, deliveredIds, lastDelivered]);
}
