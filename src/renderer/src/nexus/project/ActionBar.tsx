import { useState } from 'react';
import { getUserAction } from '@shared/nexus/actions';
import { nexusClient } from '../data/nexusClient';
import { errorCopy, execFailText } from '../data/errorCopy';
import { useActions, useHealth, withIntent } from '../data/useExecution';
import { useParticipationIndex } from '../data/useParticipations';
import { viewOf } from '../workspaces/participation';
import { Button } from '../ui/Button';
import { useExecutionUi } from './execContext';
import { actionBar } from './actionModel';

/** The actions of one workspace here: available ones as buttons, the others as sentences that say why (with "How to
 *  set up" when the fix is on this computer). With a version, only actions that take it as an input. Actions of
 *  steps not in this release are not listed. */
export function ActionBar({ projectId, workspaceId, version, title }: {
  projectId: string; workspaceId: string; title: string;
  version: { id: string; kind: string; status: string } | null;
}) {
  const ui = useExecutionUi();
  const { availability } = useHealth();
  const list = useActions(projectId, workspaceId, version?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  if (!ui) return null; // outside a project bench (the Artifacts page): nothing to open the sheets with
  if (list.fail) {
    const c = errorCopy(list.fail.code, list.fail.reason, list.fail.subReason);
    // Execution off: the notice says why. A passing failure says so here, with Try again.
    if (c.kind !== 'busy' && c.kind !== 'internal') return null;
    return (
      <section aria-label={title}>
        <h2>{title}</h2>
        <p className="nx-muted nx-xa__line" role="status"><span>The actions could not be read. {c.text}</span> <Button variant="quiet" onClick={list.reload}>Try again</Button></p>
      </section>
    );
  }
  if (!list.data) return null;
  const view = actionBar(list.data, { workspaceId, availability, version: version ? { kind: version.kind, status: version.status } : null });
  if (view.buttons.length === 0 && view.sentences.length === 0) return null;

  const start = async (actionId: string, slot: string | null) => {
    const def = getUserAction(actionId);
    if (!def || busy) return;
    if ('inlineKind' in def.run) {
      const kind = def.run.inlineKind === 'requirement' ? 'requirement' : 'problem_statement';
      ui.openWrite({ workspaceId, kind });
      return;
    }
    setBusy(actionId); setNote(null);
    const inputs = slot && version ? [{ versionId: version.id, slot }] : [];
    const key = `start:${projectId}:${workspaceId}:${actionId}:${version?.id ?? ''}`;
    const r = await withIntent(key, (intentId) => nexusClient.jobStart({ projectId, workspaceId, actionId, inputs, params: {}, intentId }));
    setBusy(null);
    setNote(r.ok
      ? { text: r.data.created ? `${def.label}: started. Follow it in Runs.` : `${def.label}: already started. Follow it in Runs.`, alert: false }
      : { text: execFailText(r), alert: true });
  };

  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      {view.buttons.length > 0 && (
        <div className="nx-passport__actions">
          {view.buttons.map((b) => (
            <Button key={b.actionId} disabled={busy !== null} onClick={() => { void start(b.actionId, b.slot); }}>
              {busy === b.actionId ? 'Starting…' : `${b.label}${b.inline ? '…' : ''}`}
            </Button>
          ))}
        </div>
      )}
      {view.buttons.some((b) => b.needsApproval) && <p className="nx-muted">Installing dependencies asks for your approval before anything is downloaded.</p>}
      {view.sentences.length > 0 && (
        <ul className="nx-xa__why">
          {view.sentences.map((s) => (
            <li key={s.actionId}>
              <span>{s.text}</span>
              {s.setup && <Button variant="quiet" onClick={ui.openSetup}>How to set up</Button>}
            </li>
          ))}
        </ul>
      )}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
    </section>
  );
}

/** The project-level bars: one per active workspace of the project (actions that take no input, and why others wait). */
export function ProjectActions({ projectId }: { projectId: string }) {
  const idx = useParticipationIndex();
  const rows = (idx.byProject.get(projectId) ?? []).filter((r) => r.status === 'active');
  return (
    <>
      {rows.map((r) => (
        <ActionBar key={r.workspaceId} projectId={projectId} workspaceId={r.workspaceId} version={null} title={`${viewOf(r.workspaceId).label} actions`} />
      ))}
    </>
  );
}
