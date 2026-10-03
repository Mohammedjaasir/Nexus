export type AgentRow = { id: string; title: string; role: string; provider: string; status: string; queued: number; hasTerminal: boolean };
type A = { id: string; name: string; isGod?: boolean; isAssistant?: boolean; provider?: string; status: string; ptyId?: string | null; archived?: boolean };

/** The lead agent is shown by role. Other agents keep the name the user (or
 *  the legacy add-agent flow) gave them; renaming is out of Phase A scope. */
export function agentRows(agents: A[], queues: Record<string, unknown[]>): AgentRow[] {
  return agents.filter((a) => !a.archived)
    .map((a) => ({
      id: a.id,
      title: a.isGod ? 'Lead agent' : a.isAssistant ? 'Assistant' : a.name,
      role: a.isGod ? 'Coordinates the other agents' : a.isAssistant ? 'Helps the lead agent' : 'Agent',
      provider: a.provider ?? 'claude',
      status: a.status,
      queued: (queues[a.id] ?? []).length,
      hasTerminal: !!a.ptyId
    }))
    .sort((x, y) => Number(y.title === 'Lead agent') - Number(x.title === 'Lead agent'));
}
