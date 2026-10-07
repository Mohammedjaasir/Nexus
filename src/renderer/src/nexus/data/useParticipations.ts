import { useEffect, useMemo } from 'react';
import { useStore } from '@/store/store';
import { legacyIndex, type ParticipationIndex } from '../workspaces/participation';
import { nexusClient } from './nexusClient';
import { usePlatform } from './platformStore';

let seq = 0;

/** Reads every participation once; a newer request makes an older answer stale. */
export async function loadParticipations(): Promise<void> {
  const mine = ++seq;
  const r = await nexusClient.participationsList();
  if (mine !== seq) return;
  usePlatform.getState().applyParticipations(r);
}

/** Mounted once, in the shell. Loads on mount, when the project list's signature
 *  (id, domain and update time of each project) changes, and on every `rev`.
 *  It only reads `useStore.projects`; it never writes it, so it cannot loop. */
export function useParticipations(): void {
  const projects = useStore((s) => s.projects);
  const rev = usePlatform((s) => s.rev);
  const signature = useMemo(() => projects.map((p) => `${p.id}:${p.domainId}:${p.updatedAt}`).join('|'), [projects]);
  useEffect(() => { void loadParticipations(); }, [signature, rev]);
}

/** The index every screen reads: the database's when it has been read, else the
 *  legacy domain grouping (labelled by PlatformNotice while the platform is unavailable). */
export function useParticipationIndex(): ParticipationIndex {
  const db = usePlatform((s) => s.participations);
  const projects = useStore((s) => s.projects);
  const legacy = useMemo(() => (db ? null : legacyIndex(projects)), [db, projects]);
  return db ?? (legacy as ParticipationIndex);
}
