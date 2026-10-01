import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { navigate } from '../router/useRoute';
import { resolveAssistantStatus, type AssistantPort } from './port';

/** Mirrors MessageQueueComposer's useDeliveryPaused: poll the control snapshot. */
function useDeliveryPaused(agentId: string | null): boolean {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!agentId) { setPaused(false); return; }
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive) setPaused(!!s?.autoDeliveryPaused); })
        .catch(() => { /* main not ready — assume not paused */ });
    };
    read();
    const iv = setInterval(read, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [agentId]);
  return paused;
}

export function useLeadAgentPort(): AssistantPort {
  const god = useStore((s) => s.agents.find((a) => a.isGod) ?? null);
  const godStatus = useStore((s) => s.godStatus);
  const paused = useDeliveryPaused(god?.id ?? null);
  const status = resolveAssistantStatus({ god: god ? { id: god.id, name: god.name } : null, godStatus, deliveryPaused: paused });
  return {
    status,
    replyHint: 'Replies appear in the lead agent\u2019s terminal in Agents.',
    send: ({ text, contextHeader }) => {
      const trimmed = text.trim();
      if (!trimmed) return { ok: false, error: 'Type a message first.' };
      if (status.state === 'unavailable') return { ok: false, error: status.reason };
      const instruction = contextHeader ? `${contextHeader}\n${trimmed}` : trimmed;
      useStore.getState().enqueueMessage(status.target.id, trimmed, { instruction });
      return { ok: true, target: status.target };
    },
    openConversation: () => {
      if (god) useStore.getState().select(god.id);
      navigate({ name: 'agents' });
    }
  };
}
