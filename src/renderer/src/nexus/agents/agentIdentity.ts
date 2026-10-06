import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { canonicalAgents, displayAgents, type AgentDisplay, type DisplayHint, type DisplayInput } from '@shared/agentDisplay';

const EMPTY: ReadonlySet<string> = new Set();

/** Reads the hive registry once per mount; its ids keep a seed record visible
 *  and its godId is the lead hint. Read-only: nothing is written back. */
export function useRegistryIds(): DisplayHint {
  const [state, setState] = useState<{ godId: string | null; registryIds: ReadonlySet<string> }>({ godId: null, registryIds: EMPTY });
  useEffect(() => {
    let alive = true;
    try {
      window.cth.hiveRegistry()
        .then((r) => { if (alive && r) setState({ godId: r.godId ?? null, registryIds: new Set(Object.keys(r.agents ?? {})) }); })
        .catch(() => { /* main not ready: no hint */ });
    } catch { /* preload missing: no hint */ }
    return () => { alive = false; };
  }, []);
  return state;
}

/** The one canonical ordered list every label is built from: live agents,
 *  then restorable, then archived. Same agent, same label, on every surface. */
export function useCanonicalAgents(): DisplayInput[] {
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const archived = useStore((s) => s.archivedAgents);
  return useMemo(() => canonicalAgents<DisplayInput>(agents, restorable, archived), [agents, restorable, archived]);
}

/** The display model for every known agent, memoised. */
export function useAgentDisplay(): { display: Map<string, AgentDisplay>; hint: DisplayHint; canon: DisplayInput[] } {
  const canon = useCanonicalAgents();
  const hint = useRegistryIds();
  const display = useMemo(() => displayAgents(canon, hint), [canon, hint]);
  return { display, hint, canon };
}
