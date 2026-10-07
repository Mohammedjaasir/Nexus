import { useCallback, useEffect, useRef, useState } from 'react';
import type { NexusFail } from '@shared/nexus/ipc';
import { nexusClient } from './nexusClient';
import { usePlatform } from './platformStore';
import {
  ARTIFACT_PAGE, NO_LIST, detailLoading, filterKey, listRequest, nextArtifactList, nextDetail, nextLimit, startListRead,
  type ArtifactDetailState, type ArtifactFilters, type ArtifactListState
} from '../pages/artifactsPageModel';

const INTERNAL: NexusFail = { ok: false, code: 'internal', message: 'The request could not be completed.' };

/** Every artifact the person may read (nexus:artifacts:list) under the page's filters. A filter change starts
 *  over from the first page; `showMore` asks for a larger page (the channel has no cursor). Reloads on every
 *  platform `rev` and when the platform mode changes; a newer request makes an older answer stale. Never rejects. */
export function useArtifactList(filters: ArtifactFilters): ArtifactListState & { limit: number; reload: () => void; showMore: () => void } {
  const rev = usePlatform((s) => s.rev);
  const mode = usePlatform((s) => s.mode);
  const key = filterKey(filters);
  // The page size belongs to one filter key: a new filter starts from the first page.
  const [paging, setPaging] = useState({ key, limit: ARTIFACT_PAGE });
  const limit = paging.key === key ? paging.limit : ARTIFACT_PAGE;
  const [state, setState] = useState<ArtifactListState>(NO_LIST);
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const showMore = useCallback(() => setPaging({ key, limit: nextLimit(limit) }), [key, limit]);

  useEffect(() => {
    const mine = ++seq.current;
    const request = listRequest(filters, limit);
    setState((prev) => startListRead(prev, key));
    void (async () => {
      try {
        const r = await nexusClient.artifactsList(request);
        if (mine !== seq.current) return;
        setState((prev) => nextArtifactList(prev, key, r));
      } catch {
        if (mine === seq.current) setState((prev) => nextArtifactList(prev, key, INTERNAL));
      }
    })();
    return () => { seq.current += 1; };
    // `filters` is read through `key`, which holds every value the request sends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, limit, rev, mode, attempt]);

  return { ...state, limit, reload, showMore };
}

/** One artifact (nexus:artifact:get) for the detail pane: which project it belongs to and the version the
 *  Passport shows. Reloads on the id, every `rev` and a mode change; stale answers are dropped. Never rejects. */
export function useArtifactDetail(id: string): ArtifactDetailState & { reload: () => void } {
  const rev = usePlatform((s) => s.rev);
  const mode = usePlatform((s) => s.mode);
  const [state, setState] = useState<ArtifactDetailState>(() => detailLoading(id));
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => { setState(detailLoading(id)); }, [id]);

  useEffect(() => {
    const mine = ++seq.current;
    void (async () => {
      try {
        const r = await nexusClient.artifactGet(id);
        if (mine !== seq.current) return;
        setState((prev) => nextDetail(prev, id, r));
      } catch {
        if (mine === seq.current) setState((prev) => nextDetail(prev, id, INTERNAL));
      }
    })();
    return () => { seq.current += 1; };
  }, [id, rev, mode, attempt]);

  // Until the reset above lands, never show the previous artifact under the new id.
  return { ...(state.id === id ? state : detailLoading(id)), reload };
}
