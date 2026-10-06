import { displayAgents, displayNameForId, type DisplayInput } from '@shared/agentDisplay';

/** One agent row as the voice read layer gets it (hive registry or the
 *  `hive:agentDirectory` rows). Only the fields the display mapping needs. */
export interface VoiceAgentRow {
  id: string;
  name?: string;
  isGod?: boolean;
  isAssistant?: boolean;
  cwd?: string | null;
  archived?: boolean;
}

/**
 * The name voice speaks for an agent id: the same label the screen shows
 * (src/shared/agentDisplay.ts), never the stored name. Ids stay ids wherever
 * they are tool arguments; this is for spoken text only (B0a final review,
 * finding 3). Active agents are labelled before archived ones, like the
 * screen's canonical order, so duplicate suffixes match.
 */
export function voiceNamer(rows: readonly VoiceAgentRow[], godId?: string | null): (id: string | null | undefined) => string {
  const ordered = [...rows.filter((r) => !r.archived), ...rows.filter((r) => r.archived)];
  const inputs: DisplayInput[] = ordered.map((r) => ({
    id: r.id,
    name: r.name,
    isGod: r.isGod === true,
    isAssistant: r.isAssistant === true,
    cwd: r.cwd ?? null
  }));
  const hint = { godId: godId ?? null, registryIds: new Set(rows.map((r) => r.id)) };
  const labels = displayAgents(inputs, hint);
  return (id) => {
    if (!id) return '';
    return labels.get(id)?.label ?? displayNameForId(id, [], hint);
  };
}

/** Registry `agents` map (id → meta) to voice rows. */
export function voiceRowsFromRegistry(agents: unknown): VoiceAgentRow[] {
  if (!agents || typeof agents !== 'object') return [];
  return Object.entries(agents as Record<string, unknown>).map(([id, raw]) => {
    const m = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      id,
      name: typeof m.name === 'string' ? m.name : undefined,
      isGod: m.isGod === true,
      isAssistant: m.isAssistant === true,
      cwd: typeof m.cwd === 'string' ? m.cwd : null,
      archived: m.archived === true
    };
  });
}
