import { useEffect, useId, useRef, useState } from 'react';
import type { JobView } from '@shared/nexus/ipc';
import { useAssistant } from '../assistant/useAssistant';
import { useNexusUi } from '../state/uiStore';
import { nexusClient } from '../data/nexusClient';
import { errorCopy, execFailText } from '../data/errorCopy';
import { useJobs, useExecStore, withIntent } from '../data/useExecution';
import { useExecutionUi } from '../project/execContext';
import { Button } from '../ui/Button';
import { RunStrip } from './RunStrip';
import { useRuns } from './useRuns';
import { STAGE_STATE_TEXT, jobRun } from './jobRunModel';

/** The first failed (or not run) check summary of what a finished job made: the sourced reason of its headline. */
function useCheckReason(job: JobView, enabled: boolean): string | null {
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setReason(null); return; }
    let alive = true;
    void (async () => {
      const d = await nexusClient.jobGet(job.id);
      if (!d.ok) return;
      for (const id of [...d.data.outputs.map((o) => o.versionId), ...d.data.inputs.map((i) => i.versionId)].slice(0, 4)) {
        const v = await nexusClient.versionValidations(id);
        if (!v.ok) continue;
        const bad = v.data.find((x) => x.blocking && (x.status === 'failed' || x.status === 'error'));
        if (bad?.summary) { if (alive) setReason(bad.summary); return; }
      }
    })();
    return () => { alive = false; };
  }, [job.id, job.updatedAt, enabled]);
  return reason;
}

function JobRow({ job, explain }: { job: JobView; explain: boolean }) {
  const titleId = useId();
  const ui = useExecutionUi();
  const reason = useCheckReason(job, explain && (job.headline === 'checks_failed' || job.headline === 'checks_could_not_run'));
  const run = jobRun(job, { reason });
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const act = async (kind: 'cancel' | 'retry') => {
    if (busy) return;
    setBusy(kind); setNote(null);
    const r = kind === 'cancel' ? await nexusClient.jobCancel(job.id) : await withIntent(`retry:${job.id}`, (id) => nexusClient.jobRetry(job.id, id));
    useExecStore.getState().bump(['jobs', 'approvals']);
    if (!alive.current) return;
    setBusy(null);
    if (!r.ok) setNote(execFailText(r));
  };
  return (
    <article className={`nx-run${run.needsYou ? ' nx-run--needs-input' : ''}`} aria-labelledby={titleId}>
      <header className="nx-run__head">
        <h3 id={titleId} className="nx-run__title">{run.title}</h3>
        <span className="nx-run__headline" aria-live="polite">{run.headline}</span>
      </header>
      <ol className="nx-run__stages" aria-label="Stages">
        {run.stages.map((s) => (
          <li key={s.id} data-state={s.state === 'stopped' ? 'unreported' : s.state === 'waiting' ? 'waiting' : s.state}>
            <span>{s.label}</span>
            <span className="nx-visually-hidden">: {STAGE_STATE_TEXT[s.state]}</span>
          </li>
        ))}
      </ol>
      <p className="nx-run__note">{run.word} · {new Date(job.createdAt).toLocaleString()}{job.attempts > 1 ? ` · ${job.attempts} attempts` : ''}</p>
      <div className="nx-run__actions">
        {run.canCancel && <Button disabled={busy !== null} onClick={() => { void act('cancel'); }}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</Button>}
        {run.canRetry && <Button disabled={busy !== null} onClick={() => { void act('retry'); }}>{busy === 'retry' ? 'Retrying…' : 'Retry'}</Button>}
        {ui && job.attempts > 0 && <Button variant="quiet" onClick={() => ui.openLog({ jobId: job.id })}>Logs</Button>}
      </div>
      {note && <p className="nx-passport__note" role="alert">{note}</p>}
    </article>
  );
}

/** Jobs of this project, persisted (nexus:jobs:list), newest first. */
function JobsSection({ projectId }: { projectId: string }) {
  const jobs = useJobs(projectId);
  const off = jobs.fail ? errorCopy(jobs.fail.code, jobs.fail.reason, jobs.fail.subReason) : null;
  return (
    <section className="nx-xj" aria-labelledby="nx-xj-title">
      <h2 id="nx-xj-title" className="nx-xj__title">Jobs</h2>
      {/* The execution notice is the bench's (one line above every tool), not repeated here. */}
      {off && off.kind !== 'execution_unavailable' && off.kind !== 'unavailable' && (
        <p className="nx-muted" role="status">{off.text} {off.retry && <Button variant="quiet" onClick={jobs.reload}>Try again</Button>}</p>
      )}
      {!jobs.loaded && !off && <p className="nx-muted" role="status">Reading jobs…</p>}
      {jobs.loaded && !off && (jobs.data ?? []).length === 0 && <p className="nx-muted">No jobs have run for this project.</p>}
      {(jobs.data ?? []).length > 0 && (
        <ul className="nx-runs">
          {(jobs.data ?? []).map((j, i) => <li key={j.id}><JobRow job={j} explain={i < 5} /></li>)}
        </ul>
      )}
    </section>
  );
}

/** Jobs of this project (persisted), then the requests sent from it in this session, newest first. */
export function ProjectRuns({ projectId }: { projectId: string }) {
  const port = useAssistant();
  const setDraft = useNexusUi((s) => s.setDraft);
  const focusIntent = useNexusUi((s) => s.focusIntent);
  const entries = useRuns().filter((e) => e.request.projectId === projectId).reverse();
  return (
    <section className="nx-surface" aria-labelledby="nx-surface-title">
      <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>Runs</h1>
      <JobsSection projectId={projectId} />
      <h2 className="nx-xj__title">Requests sent this session</h2>
      {entries.length === 0 ? (
        <p className="nx-muted">No requests sent from this project in this session. Requests you send with the intent line appear here.</p>
      ) : (
        <ul className="nx-runs">
          {entries.map(({ request, run }) => (
            <li key={request.id}>
              <RunStrip
                run={run}
                onOpenConversation={port.openConversation}
                // Prefill only: the user reviews and sends it themselves.
                onRetry={() => { setDraft(request.text); focusIntent(); }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
