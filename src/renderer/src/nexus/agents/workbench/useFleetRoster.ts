import { useEffect, useState } from 'react';
import type { AgentProvider } from '@/store/config';

/** The roster settings Team reads from config: the total token budget, per-agent
 *  token limits, the lead agent's engine and model, the app default model and
 *  the registered folders. Moved from the retired lead panel's roster. */
export function useFleetRoster(): {
  repos: string[];
  /** Total token budget (drives the breaker); also the meter's fallback denominator. */
  tokenCap: number | undefined;
  agentTokenCaps: Record<string, number>;
  setAgentCap: (id: string, tokens: number | undefined) => void;
  engineProvider: AgentProvider;
  setEngineProvider: (p: AgentProvider) => void;
  engineModel: string | undefined;
  setEngineModel: (m: string | undefined) => void;
  defaultModel: string | undefined;
  loaded: boolean;
} {
  const [repos, setRepos] = useState<string[]>([]);
  const [tokenCap, setTokenCap] = useState<number | undefined>(undefined);
  // Per-agent token limit (overrides the total budget for that agent), keyed by id.
  const [agentTokenCaps, setAgentTokenCaps] = useState<Record<string, number>>({});
  const [engineProvider, setEngineProvider] = useState<AgentProvider>('claude');
  const [engineModel, setEngineModel] = useState<string | undefined>(undefined);
  // The app's own default model (Settings → default model). The lead agent and
  // every new agent spawn on this, so the picker marks it.
  const [defaultModel, setDefaultModel] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    window.cth.getConfig().then((c) => {
      if (!alive) return;
      setRepos(c.registeredRepos ?? []);
      setTokenCap(c.costCapTokens);
      setAgentTokenCaps(c.agentTokenCaps ?? {});
      setEngineProvider(c.godProvider ?? 'claude');
      setEngineModel(c.godModel);
      setDefaultModel(c.defaultModel);
      setLoaded(true);
    }).catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  // Set/clear one agent's token limit; persist the whole map (writeConfig replaces
  // the top-level key, so we send the full merged map). Drives that agent's meter
  // and the breaker's per-agent trip.
  const setAgentCap = (id: string, tokens: number | undefined): void => {
    const next = { ...agentTokenCaps };
    if (tokens && tokens > 0) next[id] = tokens; else delete next[id];
    setAgentTokenCaps(next);
    void window.cth.updateConfig({ agentTokenCaps: next }).catch(() => { /* noop */ });
  };

  return { repos, tokenCap, agentTokenCaps, setAgentCap, engineProvider, setEngineProvider, engineModel, setEngineModel, defaultModel, loaded };
}
