import { useEffect, useRef, useState } from 'react';
import type { ApprovalView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { errorCopy } from '../data/errorCopy';
import { useApprovals, useExecStore } from '../data/useExecution';
import { Button } from '../ui/Button';
import { approvalRow } from './actionModel';

/** Approval rows: what is asked, exactly what it reaches or downloads, when it expires, and only "Approve once" or
 *  "Deny". Approving asks once more inline; the wording is the DTO's own. */
export function ApprovalList({ approvals, label }: { approvals: ApprovalView[]; label: string }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; alert: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const now = Date.now();
  const answer = async (id: string, decision: 'once' | 'deny') => {
    if (pending) return;
    setPending(id);
    const r = await nexusClient.approvalRespond(id, decision);
    useExecStore.getState().bump(['approvals', 'jobs', 'health']);
    if (!alive.current) return;
    setPending(null); setConfirming(null);
    setNote(r.ok ? { id, text: decision === 'once' ? 'Approved once.' : 'Denied.', alert: false }
      : { id, text: errorCopy(r.code, r.reason, r.subReason).text, alert: true });
  };
  return (
    <ul className="nx-xq__list" aria-label={label}>
      {approvals.map((a) => {
        const v = approvalRow(a, now);
        return (
          <li key={a.id} className="nx-xq__row">
            <p className="nx-xq__head"><b>{v.title}</b> <span className="nx-xq__word">{v.word}</span></p>
            <p className="nx-xq__text">{v.summary}</p>
            {v.facts.length > 0 && (
              <dl className="nx-xq__facts">{v.facts.map((f) => <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
            )}
            <p className="nx-muted nx-xq__meta">{v.expires}</p>
            {v.answers.length > 0 && confirming !== a.id && (
              <div className="nx-xq__acts">
                <Button variant="primary" disabled={pending !== null} onClick={() => setConfirming(a.id)}>Approve once</Button>
                <Button disabled={pending !== null} onClick={() => { void answer(a.id, 'deny'); }}>{pending === a.id ? 'Answering…' : 'Deny'}</Button>
              </div>
            )}
            {v.answers.length > 0 && confirming === a.id && (
              <div className="nx-xq__confirm" role="group" aria-label={`Approve ${v.title} once`}>
                <p>Allow this once? It reaches only what is listed above, for this request only.</p>
                <div className="nx-xq__acts">
                  <Button variant="primary" disabled={pending !== null} onClick={() => { void answer(a.id, 'once'); }}>{pending === a.id ? 'Answering…' : 'Approve once'}</Button>
                  <Button disabled={pending !== null} onClick={() => setConfirming(null)}>Cancel</Button>
                </div>
              </div>
            )}
            {note && note.id === a.id && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** "Waiting for your approval" in the project: pending requests only; nothing at all while there are none. */
export function ApprovalsSection({ projectId }: { projectId: string }) {
  const a = useApprovals(projectId);
  const waiting = (a.data ?? []).filter((x) => x.status === 'pending');
  if (waiting.length === 0) return null;
  return (
    <section className="nx-xq" aria-labelledby="nx-xq-title">
      <h2 id="nx-xq-title" className="nx-xq__title">Waiting for your approval</h2>
      <ApprovalList approvals={waiting} label="Requests waiting for your approval" />
    </section>
  );
}
