import type { WorkspaceConfig } from '../workspaces/types';

export interface IndexEntry { id: string; name: string; label: string; vocabulary: string[]; domainIds: string[] }

export function entriesFromRegistry(ws: WorkspaceConfig[]): IndexEntry[] {
  return ws.map((w) => ({ id: w.id, name: w.name, label: w.label, vocabulary: w.plannedModules, domainIds: w.domainIds }));
}

function words(s: string): string[] { return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }

/** Rank: 0 name/label prefix, 1 word prefix in name, 2 vocabulary word prefix,
 *  3 domain id substring. Ties keep registry order. */
export function matchEntries(entries: IndexEntry[], query: string): IndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  const ranked: { e: IndexEntry; r: number; i: number }[] = [];
  entries.forEach((e, i) => {
    let r = -1;
    if (e.name.toLowerCase().startsWith(q) || e.label.toLowerCase().startsWith(q)) r = 0;
    else if (words(e.name).some((w) => w.startsWith(q))) r = 1;
    else if (e.vocabulary.some((v) => words(v).some((w) => w.startsWith(q) || (w.length >= 4 && q.startsWith(w))))) r = 2;
    else if (e.domainIds.some((d) => d.includes(q))) r = 3;
    if (r >= 0) ranked.push({ e, r, i });
  });
  return ranked.sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.e);
}

export function moveActive(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(length - 1, Math.max(0, current + delta));
}

export function resolveEnter(entries: IndexEntry[], active: number): string | null {
  return active >= 0 && active < entries.length ? entries[active].id : null;
}
