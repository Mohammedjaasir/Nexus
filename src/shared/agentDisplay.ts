// One source for how an agent is named on screen. Pure, no imports: shared by
// the renderer and the main process. Display-time only: stored names, the hive
// registry and the database are never rewritten from here.

export const LEAD_AGENT_ID = 'god';
export const LEAD_AGENT_LABEL = 'Lead agent';
export const LEAD_AGENT_ROLE = 'Coordinates the other agents';
const DUPLICATE_LEAD_LABEL = 'Lead agent (duplicate record)';
const DUPLICATE_LEAD_ROLE = 'Not the running lead agent';
const ASSISTANT_LABEL = 'Assistant';
const ASSISTANT_ROLE = 'Helps the lead agent';

/** Two seed records from the first-run roster that are dead without a pty or a registry entry. */
export const LEGACY_SEED_IDS: readonly string[] = ['agent-god', 'agent-ryan'];

export const OLD_CAST_NAMES: ReadonlySet<string> = new Set([
  'michael', 'dwight', 'jim', 'pam', 'ryan', 'creed', 'oscar', 'kevin',
  'angela', 'stanley', 'andy', 'toby', 'meredith', 'phyllis', 'kelly'
]);

export const SYSTEM_SENDERS: Readonly<Record<string, string>> = {
  human: 'You',
  breaker: 'Circuit breaker',
  'michael-voice': 'Voice',
  webhook: 'Webhook',
  slack: 'Slack',
  system: 'Nexus'
};

export interface DisplayInput {
  id: string;
  name?: string;
  isGod?: boolean;
  isAssistant?: boolean;
  cwd?: string | null;
  ptyId?: string | null;
  description?: string | null;
}
export interface DisplayHint { godId?: string | null; registryIds?: ReadonlySet<string> }
export interface AgentDisplay { label: string; role: string; isLead: boolean; isDuplicateLead: boolean }

export function folderName(cwd?: string | null): string {
  if (!cwd) return '';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

export function leadAgentId(agents: readonly DisplayInput[], hint?: DisplayHint): string | null {
  const has = (id: string): boolean => agents.some((a) => a.id === id);
  if (hint?.godId && has(hint.godId)) return hint.godId;
  if (has(LEAD_AGENT_ID)) return LEAD_AGENT_ID;
  return agents.find((a) => a.isGod)?.id ?? null;
}

export function isLegacySeed(a: DisplayInput, hint?: DisplayHint): boolean {
  return LEGACY_SEED_IDS.includes(a.id) && !a.ptyId && !hint?.registryIds?.has(a.id);
}

export function visibleAgents<T extends DisplayInput>(agents: readonly T[], hint?: DisplayHint): T[] {
  return agents.filter((a) => !isLegacySeed(a, hint));
}

export function displayAgents(agents: readonly DisplayInput[], hint?: DisplayHint): Map<string, AgentDisplay> {
  const visible = visibleAgents(agents, hint);
  const lead = leadAgentId(visible, hint);
  const out = new Map<string, AgentDisplay>();
  const seen = new Map<string, number>();
  for (const a of visible) {
    if (out.has(a.id)) continue; // a restorable copy of a live agent
    let label: string;
    let role: string;
    const isLead = a.id === lead;
    const isDuplicateLead = !isLead && !!a.isGod;
    if (isLead) { label = LEAD_AGENT_LABEL; role = LEAD_AGENT_ROLE; }
    else {
      if (isDuplicateLead) { label = DUPLICATE_LEAD_LABEL; role = DUPLICATE_LEAD_ROLE; }
      else {
        role = a.isAssistant ? ASSISTANT_ROLE : 'Agent';
        const name = (a.name ?? '').trim();
        if (a.isAssistant) label = ASSISTANT_LABEL;
        else if (!name || OLD_CAST_NAMES.has(name.toLowerCase())) {
          const folder = folderName(a.cwd);
          label = folder ? `Agent · ${folder}` : 'Agent';
        } else label = a.name as string;
      }
      const n = (seen.get(label) ?? 0) + 1;
      seen.set(label, n);
      if (n > 1) label = `${label} (${n})`;
    }
    out.set(a.id, { label, role, isLead, isDuplicateLead });
  }
  return out;
}

export function displayNameForId(id: string | null | undefined, agents: readonly DisplayInput[], hint?: DisplayHint): string {
  if (!id) return '';
  const hit = displayAgents(agents, hint).get(id);
  if (hit) return hit.label;
  if (id === LEAD_AGENT_ID) return LEAD_AGENT_LABEL;
  return SYSTEM_SENDERS[id] ?? id;
}

export function displayDescription(a: DisplayInput, isLead: boolean): string {
  if (isLead) return LEAD_AGENT_ROLE;
  const d = (a.description ?? '').trim();
  if (!d) return '';
  return d.replace(/\bwaiting on god\b/gi, 'Waiting for the lead agent').replace(/\bgod\b/gi, 'the lead agent');
}
