import { useMemo, useState } from 'react';
import type { ArtifactSummaryView } from '@shared/nexus/ipc';
import { getUserAction } from '@shared/nexus/actions';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { useActions, useHealth, withIntent } from '../data/useExecution';
import { useParticipationIndex } from '../data/useParticipations';
import { viewOf } from '../workspaces/participation';
import { Button } from '../ui/Button';
import { useExecutionUi } from './execContext';
import { actionBar } from './actionModel';

/** Kinds with a version usable as an input now: candidate or active (the shown version of each artifact). */
export function usableKindsOf(artifacts: readonly ArtifactSummaryView[]): Set<string> {
  const out = new Set<string>();
  for (const s of artifacts) {
    if (s.artifact.status !== 'active') continue;
    if (s.current || (s.latest && (s.latest.status === 'candidate' || s.latest.status === 'active'))) out.add(s.artifact.kind);
  }
  return out;
}

/** The actions of one workspace here: available ones as buttons, the others as sentences that say why (with "How to
 *  set up" when the fix is on this computer). Actions of steps not in this release are not listed. */
export function ActionBar({ projectId, workspaceId, version, artifacts, title }: {
  projectId: string; workspaceId: string; title: string;
  version: { id: string; kind: string; status: string } | null;
  artifacts: readonly ArtifactSummaryView[];
}) {
  const ui = useExecutionUi();
  const { availability } = useHealth();
  const list = useActions(projectId, workspaceId, version?.id ?? null);
  const usable = useMemo(() => usableKindsOf(artifacts), [artifacts]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  if (!ui || !list.data) return null; // execution off or outside a project bench: the notice says why
  const view = actionBar(list.data, { workspaceId, availability, version: version ? { kind: version.kind, status: version.status } : null, usableKinds: usable });
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

/** The project-level bars: one per active workspace of the project that has actions in this release. */
export function ProjectActions({ projectId, artifacts }: { projectId: string; artifacts: readonly ArtifactSummaryView[] }) {
  const idx = useParticipationIndex();
  const rows = (idx.byProject.get(projectId) ?? []).filter((r) => r.status === 'active');
  return (
    <>
      {rows.map((r) => (
        <ActionBar key={r.workspaceId} projectId={projectId} workspaceId={r.workspaceId} version={null} artifacts={artifacts}
          title={`${viewOf(r.workspaceId).label} actions`} />
      ))}
    </>
  );
}
