import { useState } from 'react';
import type { VersionView } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { errorCopy, execFailText } from '../data/errorCopy';
import { useValidations, withIntent } from '../data/useExecution';
import { Button } from '../ui/Button';
import { evidenceView } from './evidenceModel';

/** The Folio's evidence page for one version: the headline ("Checks passed", "Checks failed", "Checks could not
 *  run", "Checking…"), then each check with its word, its sentence and its sourced facts. Revalidate is offered
 *  only for a draft whose checks could not run. Nothing renders while execution is off (the notice says why). */
export function EvidenceSection({ version, checked = true }: { version: VersionView; checked?: boolean }) {
  // A kind no check ever gates is not read at all: it says so, and never "Checking…".
  const v = useValidations(checked ? version.id : null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; alert: boolean } | null>(null);
  if (v.fail) {
    const c = errorCopy(v.fail.code, v.fail.reason, v.fail.subReason);
    if (c.kind === 'execution_unavailable' || c.kind === 'unavailable') return null;
    return <section><h2>Checks</h2><p className="nx-muted" role="status">{c.text}</p></section>;
  }
  if (!v.loaded) return <section><h2>Checks</h2><p className="nx-muted" role="status">Reading checks…</p></section>;
  const view = evidenceView(v.data ?? [], version, checked);
  const revalidate = async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    const r = await withIntent(`revalidate:${version.id}`, (id) => nexusClient.versionRevalidate(version.id, id));
    setBusy(false);
    setNote(r.ok ? { text: 'The checks were queued again.', alert: false } : { text: execFailText(r), alert: true });
    v.reload();
  };
  return (
    <section aria-label={`Checks of version ${version.versionNo}`}>
      <h2>Checks of version {version.versionNo}</h2>
      <p className="nx-xe__headline">{view.headline}</p>
      {view.rows.length > 0 && (
        <ul className="nx-xe__list">
          {view.rows.map((r) => (
            <li key={r.validatorId} className="nx-xe__row">
              <p className="nx-xe__head"><span>{r.label}</span> <span className="nx-xe__word">{r.word}{r.blocking ? '' : ' (run result)'}</span></p>
              {r.summary && <p className="nx-xe__text">{r.summary}</p>}
              {r.latestRun && <p className="nx-muted">Latest run: {r.latestRun.word}. {r.latestRun.summary}</p>}
              {r.facts.length > 0 && (
                <dl className="nx-xe__facts">
                  {r.facts.map((f, i) => <div key={`${f.kind}:${i}`}><dt>{f.label}</dt><dd>{f.value} <span className="nx-muted">({f.source})</span></dd></div>)}
                </dl>
              )}
              {r.history > 1 && <p className="nx-muted">{r.history} results recorded for this check.</p>}
            </li>
          ))}
        </ul>
      )}
      {view.revalidate && <Button disabled={busy} onClick={() => { void revalidate(); }}>{busy ? 'Queueing checks…' : 'Revalidate'}</Button>}
      {note && <p className={note.alert ? 'nx-passport__note' : 'nx-muted'} role={note.alert ? 'alert' : 'status'}>{note.text}</p>}
    </section>
  );
}
