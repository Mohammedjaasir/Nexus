import { useEffect, useRef, useState } from 'react';
import type { NexusResult, ParticipationView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { usePlatform, selectCanWrite } from '../data/platformStore';
import { useParticipationIndex } from '../data/useParticipations';
import { PlatformNotice } from '../components/PlatformNotice';
import { UNASSIGNED_LABEL } from '../workspaces/mapping';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Popover } from '../ui/Sheet';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import {
  IDLE, addedMessage, askConfirm, attachFailureText, attachOptions, begin, cancelConfirm, confirmQuestion, failed, sectionRows,
  shouldReload, succeeded, withdrawFailureText, withdrawnMessage, type Pending, type SectionState
} from './workspacesSectionModel';

/** The project's workspaces on its source node: the primary (set by the detected
 *  domain), the attached ones, "Add to workspace" and "Withdraw". The write
 *  actions render only while the database is the authority. */
export function WorkspacesSection({ projectId }: { projectId: string }) {
  const idx = useParticipationIndex();
  const canWrite = usePlatform(selectCanWrite);
  const bumpRev = usePlatform((s) => s.bumpRev);
  const [state, setState] = useState<SectionState>(IDLE);
  // The guard against a second submit before React re-renders.
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Opening the confirmation focuses Cancel, never the destructive button.
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (state.confirming && !state.pending) cancelRef.current?.focus();
  }, [state.confirming, state.pending]);

  const rows = sectionRows(idx, projectId, canWrite);
  const options = attachOptions(idx, projectId, canWrite);
  const hasPrimary = rows.some((r) => r.isPrimary);

  const run = async (p: Pending, call: () => Promise<NexusResult<ParticipationView>>, okText: string, failText: (r: Extract<NexusResult<ParticipationView>, { ok: false }>) => string) => {
    if (running.current) return;
    const next = begin(state, p);
    if (!next) return;
    running.current = true;
    setState(next);
    const r = await call();
    running.current = false;
    // Refresh every screen even when this section has gone (the sheet closed mid-call).
    if (r.ok || shouldReload(r)) bumpRev();
    if (!alive.current) return;
    if (r.ok) setState((s) => succeeded(s, okText));
    else setState((s) => failed(s, failText(r)));
  };

  const attach = (workspaceId: string, label: string) =>
    run({ kind: 'attach', workspaceId }, () => nexusClient.participationAttach(projectId, workspaceId), addedMessage(label), attachFailureText);
  const withdraw = (participationId: string, label: string) =>
    run({ kind: 'withdraw', participationId }, () => nexusClient.participationWithdraw(participationId), withdrawnMessage(label), withdrawFailureText);

  const pending = state.pending;
  return (
    <section className="nx-pws" aria-labelledby="nx-pws-title">
      <h2 id="nx-pws-title">Workspaces</h2>
      <PlatformNotice />
      <ul className="nx-pws__list">
        {!hasPrimary && <li className="nx-pws__row"><span className="nx-pws__name">{UNASSIGNED_LABEL}</span><span className="nx-muted">No primary workspace</span></li>}
        {rows.map((r) => (
          <li key={r.participationId} className="nx-pws__row">
            <ProvenanceMark slot={r.hueSlot} size={10} />
            <span className="nx-pws__name">{r.label}</span>
            {r.isPrimary ? <Badge>Primary</Badge> : <Badge>Attached</Badge>}
            {r.canWithdraw && state.confirming !== r.participationId && (
              <span className="nx-pws__act">
                <Button variant="quiet" disabled={pending !== null} onClick={() => setState((s) => askConfirm(s, r.participationId))}>Withdraw</Button>
              </span>
            )}
            {r.canWithdraw && state.confirming === r.participationId && (
              <div className="nx-pws__confirm" role="group" aria-label={`Withdraw from ${r.label}`}>
                <p>{confirmQuestion(r.label)}</p>
                <div className="nx-pws__confirm-actions">
                  <Button variant="primary" disabled={pending !== null} onClick={() => { void withdraw(r.participationId, r.label); }}>
                    {pending?.kind === 'withdraw' && pending.participationId === r.participationId ? 'Withdrawing…' : 'Withdraw'}
                  </Button>
                  <button ref={cancelRef} type="button" className="nx-btn" disabled={pending !== null} onClick={() => setState((s) => cancelConfirm(s))}><span>Cancel</span></button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {hasPrimary && <p className="nx-muted nx-pws__hint">The primary workspace follows the detected domain.</p>}
      {canWrite && options.length > 0 && (
        <div className="nx-pws__add">
          {pending?.kind === 'attach' ? (
            <Button icon="plus" disabled>Adding…</Button>
          ) : (
            <Popover kind="listbox" label="Workspaces to add" triggerClassName="nx-btn" trigger={<span>Add to workspace</span>}>
              {(close) => options.map((o) => (
                <button key={o.workspaceId} type="button" role="option" tabIndex={-1} aria-selected={false} className="nx-menu__item"
                  disabled={pending !== null} onClick={() => { close(); void attach(o.workspaceId, o.label); }}>
                  <ProvenanceMark slot={o.hueSlot} />
                  <span className="nx-menu__text">{o.label}</span>
                </button>
              ))}
            </Popover>
          )}
        </div>
      )}
      {state.announce && <p className="nx-pws__status" role="status">{state.announce}</p>}
      {state.error && <p className="nx-passport__note" role="alert">{state.error}</p>}
    </section>
  );
}
