// Main-process wrapper over the shared display mapping. Display only: the
// registry and stored names are never rewritten from here.
import { displayNameForId } from '../shared/agentDisplay';

export interface RegistryLike { godId?: string | null; agents: Record<string, { name?: string; isGod?: boolean; cwd?: string }> }

export function agentDisplayName(agentId: string | null | undefined, reg: RegistryLike): string {
  if (!agentId) return '';
  const agents = reg?.agents ?? {};
  const list = Object.entries(agents).map(([id, a]) => ({ id, name: a.name, isGod: a.isGod, cwd: a.cwd }));
  return displayNameForId(agentId, list, { godId: reg?.godId, registryIds: new Set(Object.keys(agents)) });
}

export function notificationTitle(agentId: string | null | undefined, reg: RegistryLike): string {
  if (!agentId) return 'Agent';
  return agentDisplayName(agentId, reg) || 'Agent';
}
