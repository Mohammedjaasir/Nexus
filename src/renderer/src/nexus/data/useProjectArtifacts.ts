import { useCallback, useEffect, useRef, useState } from 'react';
import { nexusClient } from './nexusClient';
import { usePlatform } from './platformStore';
import { NO_ARTIFACTS, nextArtifacts, type ArtifactsState } from '../project/artifactModel';

/** The project's artifact summaries (nexus:artifacts:byProject): each artifact with
 *  its latest and current version. Reloads on the project, on every platform
 *  `rev` (bumped after each mutation) and when the platform mode changes. A
 *  newer request makes an older answer stale. `reload` sends the read again
 *  (the "Try again" after a passing failure). */
export function useProjectArtifacts(projectId: string): ArtifactsState & { reload: () => void } {
  const rev = usePlatform((s) => s.rev);
  const mode = usePlatform((s) => s.mode);
  const [state, setState] = useState<ArtifactsState>(NO_ARTIFACTS);
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => { setState(NO_ARTIFACTS); }, [projectId]);
  useEffect(() => {
    const mine = ++seq.current;
    void nexusClient.artifactsByProject(projectId).then((r) => {
      if (mine !== seq.current) return;
      setState((prev) => nextArtifacts(prev, r));
    });
    return () => { seq.current += 1; };
  }, [projectId, rev, mode, attempt]);
  return { ...state, reload };
}
