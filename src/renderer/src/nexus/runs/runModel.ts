export type StageId = 'context' | 'plan' | 'execute' | 'output' | 'review';
export type StageState = 'done' | 'active' | 'waiting' | 'pending' | 'unreported';
export type RunView = { id: string; title: string; headline: string; stages: { id: StageId; label: string; state: StageState }[]; needsInput: boolean; agentOffline: boolean };

const LABELS: Record<StageId, string> = { context: 'Context', plan: 'Plan', execute: 'Execute', output: 'Output', review: 'Review' };
const WORKING = new Set(['working', 'thinking']);

/** The lead agent reports only queue state and its terminal status. Plan,
 *  output and review stay "unreported" until an AgentRuntime provides them. */
export function leadAgentRun(input: { request: { id: string; text: string; sentAt: number }; queued: boolean; agentPresent: boolean; agentStatus: string | null; blocked: boolean }): RunView {
  const { queued, agentPresent, agentStatus, blocked } = input;
  let execute: StageState; let headline: string;
  // A message leaves the queue when it is delivered, or when its agent is
  // removed (the queue goes with it). Without the agent we cannot tell which.
  if (!agentPresent && !queued) { execute = 'unreported'; headline = 'Not tracked. The lead agent it was sent to is no longer running'; }
  else if (!agentPresent) { execute = 'pending'; headline = 'Queued. The lead agent is not running'; }
  else if (queued) { execute = 'pending'; headline = 'Queued for the lead agent'; }
  else if (blocked) { execute = 'waiting'; headline = 'Waiting for you in its terminal'; }
  else if (agentStatus && WORKING.has(agentStatus)) { execute = 'active'; headline = 'The lead agent is working'; }
  else { execute = 'unreported'; headline = 'Delivered. See the lead agent’s terminal for the result'; }
  const state: Record<StageId, StageState> = { context: 'done', plan: 'unreported', execute, output: 'unreported', review: 'unreported' };
  return {
    id: input.request.id,
    title: input.request.text.trim().slice(0, 80),
    headline,
    stages: (Object.keys(LABELS) as StageId[]).map((id) => ({ id, label: LABELS[id], state: state[id] })),
    needsInput: execute === 'waiting',
    agentOffline: !agentPresent
  };
}

export type RunRequest = { id: string; agentId: string; queuedMessageId: string; text: string; sentAt: number };
export type RunAgent = { id: string; status: string; running: boolean; blocked: boolean };

/** Derives each request's run from real store state only. A request is queued
 *  while its message id is still in its agent's queue. Only the newest
 *  delivered request per agent takes the agent's live status; older delivered
 *  ones cannot be told apart from later work, so they report nothing live. */
export function runsFor(requests: RunRequest[], agents: RunAgent[], queues: Record<string, { id: string }[] | undefined>): RunView[] {
  const isQueued = (r: RunRequest) => !!queues[r.agentId]?.some((m) => m.id === r.queuedMessageId);
  const latestDelivered = new Map<string, RunRequest>();
  for (const r of requests) {
    if (isQueued(r)) continue;
    const cur = latestDelivered.get(r.agentId);
    if (!cur || r.sentAt >= cur.sentAt) latestDelivered.set(r.agentId, r);
  }
  return requests.map((r) => {
    const agent = agents.find((a) => a.id === r.agentId);
    const queued = isQueued(r);
    const live = queued || latestDelivered.get(r.agentId) === r;
    return leadAgentRun({
      request: r,
      queued,
      agentPresent: !!agent?.running,
      agentStatus: live && agent ? agent.status : null,
      blocked: live && !queued && !!agent?.blocked
    });
  });
}

/** A run that is still in motion: queued, working, or waiting on the user. */
export function isRunLive(run: RunView): boolean {
  const ex = run.stages.find((s) => s.id === 'execute')?.state;
  return ex === 'pending' || ex === 'active' || ex === 'waiting';
}
