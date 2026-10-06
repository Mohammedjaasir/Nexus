import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store/store';
import { displayAgents, type AgentDisplay, type DisplayHint } from '@shared/agentDisplay';

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

/** The display model for the live roster, memoised on the agents array. */
export function useAgentDisplay(): { display: Map<string, AgentDisplay>; hint: DisplayHint } {
  const agents = useStore((s) => s.agents);
  const hint = useRegistryIds();
  const display = useMemo(() => displayAgents(agents, hint), [agents, hint]);
  return { display, hint };
}
