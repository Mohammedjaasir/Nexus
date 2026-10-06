import { canonicalAgents, displayAgents, visibleAgents, type DisplayHint } from '@shared/agentDisplay';

export type AgentRow = { id: string; title: string; role: string; provider: string; status: string; queued: number; hasTerminal: boolean };
type A = { id: string; name: string; isGod?: boolean; isAssistant?: boolean; provider?: string; status: string; ptyId?: string | null; archived?: boolean; cwd?: string | null; description?: string | null };

/** Rows come from the shared display model: the lead agent is shown by role,
 *  old cast names as "Agent · folder", dead legacy seeds are hidden. Lead
 *  first, then input order. */
export function agentRows(agents: A[], queues: Record<string, unknown[]>, hint?: DisplayHint, others: readonly A[] = []): AgentRow[] {
  const live = visibleAgents(agents.filter((a) => !a.archived), hint);
  // Numbering comes from the canonical list (live, then restorable/archived) so labels match every other surface.
  const display = displayAgents(canonicalAgents<A>(agents, others), hint);
  const rows = live.map((a) => {
    const d = display.get(a.id)!;
    return {
      row: {
        id: a.id,
        title: d.label,
        role: d.role,
        provider: a.provider ?? 'claude',
        status: a.status,
        queued: (queues[a.id] ?? []).length,
        hasTerminal: !!a.ptyId
      },
      lead: d.isLead
    };
  });
  return [...rows.filter((r) => r.lead), ...rows.filter((r) => !r.lead)].map((r) => r.row);
}
