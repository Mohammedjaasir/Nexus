import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandoffDetailView, NexusFail, NexusResult } from '@shared/nexus/ipc';
import { nexusClient } from './nexusClient';
import { usePlatform } from './platformStore';
import {
  HANDOFF_PAGE, NO_HANDOFF_LIST, PASSPORT_HANDOFF_READS, handoffDetailLoading, handoffListRequest, handoffViewKey, handoffsCarrying,
  nextHandoffDetail, nextHandoffLimit, nextHandoffList, receiptArtifactId, startHandoffListRead,
  type CarryingRow, type HandoffDetailState, type HandoffListState, type HandoffView
} from '../handoffs/handoffModel';
import { errorCopy } from './errorCopy';

const INTERNAL: NexusFail = { ok: false, code: 'internal', message: 'The request could not be completed.' };

/** The handoffs of one view (nexus:handoffs:list): inbox, sent or all, for every workspace or one, with a
 *  status filter. A view change starts over from the first page; `showMore` asks for a larger page (the
 *  channel has no cursor). Reloads on every platform `rev` and mode change; a newer request makes an older
 *  answer stale. Every answer tells the store whether handoffs are on. Never rejects. */
export function useHandoffList(view: HandoffView): HandoffListState & { limit: number; reload: () => void; showMore: () => void } {
  const rev = usePlatform((s) => s.rev);
  const mode = usePlatform((s) => s.mode);
  const noteHandoffs = usePlatform((s) => s.noteHandoffs);
  const key = handoffViewKey(view);
  const [paging, setPaging] = useState({ key, limit: HANDOFF_PAGE });
  const limit = paging.key === key ? paging.limit : HANDOFF_PAGE;
  const [state, setState] = useState<HandoffListState>(NO_HANDOFF_LIST);
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const showMore = useCallback(() => setPaging({ key, limit: nextHandoffLimit(limit) }), [key, limit]);

  useEffect(() => {
    const mine = ++seq.current;
    const request = handoffListRequest(view, limit);
    setState((prev) => startHandoffListRead(prev, key));
    void (async () => {
      try {
        const r = await nexusClient.handoffsList(request);
        noteHandoffs(r);
        if (mine !== seq.current) return;
        setState((prev) => nextHandoffList(prev, key, r));
      } catch {
        if (mine === seq.current) setState((prev) => nextHandoffList(prev, key, INTERNAL));
      }
    })();
    return () => { seq.current += 1; };
    // `view` is read through `key`, which holds every value the request sends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, limit, rev, mode, attempt]);

  return { ...state, limit, reload, showMore };
}

/** One handoff (nexus:handoff:get) with its subjects. Reloads on the id, every `rev` and a mode change; stale
 *  answers are dropped. `apply` takes the detail an answer action returned. Never rejects. */
export function useHandoffDetail(id: string): HandoffDetailState & { reload: () => void; apply: (r: NexusResult<HandoffDetailView>) => void } {
  const rev = usePlatform((s) => s.rev);
  const mode = usePlatform((s) => s.mode);
  const noteHandoffs = usePlatform((s) => s.noteHandoffs);
  const [state, setState] = useState<HandoffDetailState>(() => handoffDetailLoading(id));
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const apply = useCallback((r: NexusResult<HandoffDetailView>) => setState((prev) => nextHandoffDetail(prev, id, r)), [id]);
  useEffect(() => { setState(handoffDetailLoading(id)); }, [id]);

  useEffect(() => {
    const mine = ++seq.current;
    void (async () => {
      try {
        const r = await nexusClient.handoffGet(id);
        noteHandoffs(r);
        if (mine !== seq.current) return;
        setState((prev) => nextHandoffDetail(prev, id, r));
      } catch {
        if (mine === seq.current) setState((prev) => nextHandoffDetail(prev, id, INTERNAL));
      }
    })();
    return () => { seq.current += 1; };
  }, [id, rev, mode, attempt, noteHandoffs]);

  return { ...(state.id === id ? state : handoffDetailLoading(id)), reload, apply };
}

/** The artifact id of an accepted handoff's Received item (read from its receipt version). null until known. */
export function useReceiptArtifact(receiptVersionId: string | null): string | null {
  const [found, setFound] = useState<{ versionId: string; artifactId: string | null } | null>(null);
  useEffect(() => {
    if (!receiptVersionId) return;
    let alive = true;
    void (async () => {
      try {
        const r = await nexusClient.versionGet(receiptVersionId);
        if (alive) setFound({ versionId: receiptVersionId, artifactId: receiptArtifactId(receiptVersionId, r) });
      } catch {
        if (alive) setFound({ versionId: receiptVersionId, artifactId: null });
      }
    })();
    return () => { alive = false; };
  }, [receiptVersionId]);
  return found && found.versionId === receiptVersionId ? found.artifactId : null;
}

export interface CarryingState { rows: CarryingRow[]; loaded: boolean; error: string | null; capped: boolean }
const NO_CARRYING: CarryingState = { rows: [], loaded: false, error: null, capped: false };

/** The project's handoffs that carry a version of this artifact, for the artifact Passport. Reads the project's
 *  most recent handoffs (open first) and their subjects, only while `enabled`; reloads on every `rev`. A
 *  handoffs_unavailable answer is noted in the store, so no "Hand off" control renders. Never rejects. */
export function useArtifactHandoffs(enabled: boolean, projectId: string, artifactId: string): CarryingState {
  const rev = usePlatform((s) => s.rev);
  const noteHandoffs = usePlatform((s) => s.noteHandoffs);
  const [state, setState] = useState<CarryingState>(NO_CARRYING);
  useEffect(() => {
    if (!enabled) { setState(NO_CARRYING); return; }
    let alive = true;
    void (async () => {
      try {
        const list = await nexusClient.handoffsList({ projectId, box: 'all', limit: PASSPORT_HANDOFF_READS });
        noteHandoffs(list);
        if (!alive) return;
        if (!list.ok) {
          const copy = errorCopy(list.code, list.reason, list.subReason);
          setState({ rows: [], loaded: true, error: copy.kind === 'unavailable' ? null : copy.text, capped: false });
          return;
        }
        const reads = await Promise.all(list.data.map((h) => nexusClient.handoffGet(h.id)));
        if (!alive) return;
        const details = reads.flatMap((r) => (r.ok ? [r.data] : []));
        setState({
          rows: handoffsCarrying(details, artifactId), loaded: true, capped: list.truncated === true,
          error: reads.some((r) => !r.ok) ? 'Some handoffs could not be read, so they are not listed.' : null
        });
      } catch {
        if (alive) setState((s) => ({ ...s, loaded: true, error: errorCopy('internal').text }));
      }
    })();
    return () => { alive = false; };
  }, [enabled, projectId, artifactId, rev, noteHandoffs]);
  return state;
}
