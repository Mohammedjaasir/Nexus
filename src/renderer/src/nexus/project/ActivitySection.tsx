import { useMemo } from 'react';
import { useActivity } from '../data/useActivity';
import { viewOf } from '../workspaces/participation';
import { Button } from '../ui/Button';
import type { ArtifactSummary } from './spineModel';
import { activityLine, activityNotice, versionNumbers } from './activityModel';

/** The project's recent activity as plain sentences: what happened, who acted
 *  ("You", "Nexus"), and when. Real rows only; nothing while the platform is off
 *  (the platform notice says why). */
export function ActivitySection({ projectId, artifacts }: { projectId: string; artifacts: ArtifactSummary[] }) {
  const a = useActivity(projectId);
  const names = useMemo(() => new Map(artifacts.map((s) => [s.artifact.id, s.artifact.name])), [artifacts]);
  const lines = useMemo(() => {
    const ctx = { names, versionNos: versionNumbers(a.rows, artifacts), workspaceLabel: (id: string) => viewOf(id).label, now: Date.now() };
    return a.rows.map((r) => activityLine(r, ctx));
  }, [a.rows, artifacts, names]);
  const notice = activityNotice(a);

  if (a.unavailable) return null;
  return (
    <section className="nx-acx" aria-labelledby="nx-acx-title">
      <h2 id="nx-acx-title">Recent activity</h2>
      {notice ? (
        <p className="nx-muted nx-acx__line" role="status">
          <span>{notice.text}</span>
          {notice.kind === 'error' && notice.retry && <Button variant="quiet" onClick={a.reload}>Try again</Button>}
        </p>
      ) : (
        <ol className="nx-acx__list">
          {lines.map((l) => (
            <li key={l.key} className="nx-acx__row">
              <span className="nx-acx__text">{l.text}</span>
              <span className="nx-muted nx-acx__meta">{l.actor}{l.when && <>{' · '}<time dateTime={l.at}>{l.when}</time></>}</span>
            </li>
          ))}
        </ol>
      )}
      {!notice && a.error && (
        <p className="nx-muted nx-acx__line" role="status">
          <span>{a.error}</span>
          {a.retry && <Button variant="quiet" onClick={a.reload}>Try again</Button>}
        </p>
      )}
      {!notice && a.truncated && (
        <div className="nx-acx__more">
          <Button variant="quiet" disabled={a.loadingMore} onClick={a.loadOlder}>{a.loadingMore ? 'Reading older activity…' : 'Show older activity'}</Button>
        </div>
      )}
    </section>
  );
}
