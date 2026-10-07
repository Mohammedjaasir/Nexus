import { useCallback, useEffect, useRef, useState } from 'react';
import { nexusClient } from './nexusClient';
import { usePlatform } from './platformStore';
import { ACTIVITY_PAGE, NO_ACTIVITY, nextActivity, olderPageCursor, type ActivityState } from '../project/activityModel';

const INTERNAL = { ok: false as const, code: 'internal' as const, message: 'The request could not be completed.' };

/** The project's recent activity (nexus:activity:byProject, ACTIVITY_PAGE rows a read).
 *  Reloads on the project, on every platform `rev` and when the platform mode
 *  changes; a newer request makes an older answer stale. `reload` sends the
 *  first read again; `loadOlder` appends the next older page. Never rejects. */
export function useActivity(projectId: string): ActivityState & { reload: () => void; loadOlder: () => void } {
  const rev = usePlatform((s) => s.rev);
  const mode = usePlatform((s) => s.mode);
  const [state, setState] = useState<ActivityState>(NO_ACTIVITY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => { setState(NO_ACTIVITY); }, [projectId]);

  useEffect(() => {
    const mine = ++seq.current;
    void (async () => {
      try {
        const r = await nexusClient.activityByProject(projectId, { limit: ACTIVITY_PAGE });
        if (mine !== seq.current) return;
        setState((prev) => nextActivity(prev, r, 'first'));
      } catch {
        if (mine === seq.current) setState((prev) => nextActivity(prev, INTERNAL, 'first'));
      }
    })();
    return () => { seq.current += 1; };
  }, [projectId, rev, mode, attempt]);

  const loadOlder = useCallback(() => {
    const cur = stateRef.current;
    const beforeSeq = olderPageCursor(cur);
    if (beforeSeq === null || cur.loadingMore) return;
    const mine = seq.current;
    setState((prev) => ({ ...prev, loadingMore: true }));
    void (async () => {
      try {
        const r = await nexusClient.activityByProject(projectId, { beforeSeq, limit: ACTIVITY_PAGE });
        if (mine !== seq.current) return;
        setState((prev) => nextActivity(prev, r, 'more'));
      } catch {
        if (mine === seq.current) setState((prev) => nextActivity(prev, INTERNAL, 'more'));
      }
    })();
  }, [projectId]);

  return { ...state, reload, loadOlder };
}
