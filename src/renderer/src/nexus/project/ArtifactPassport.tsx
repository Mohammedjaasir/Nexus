import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ArtifactDetail, LineageView, VersionContent } from '@shared/nexus/ipc';
import { nexusClient } from '../data/nexusClient';
import { usePlatform } from '../data/platformStore';
import { useParticipationIndex } from '../data/useParticipations';
import { errorCopy } from '../data/errorCopy';
import { viewOf } from '../workspaces/participation';
import type { ArtifactNode, ArtifactSummary } from './spineModel';
import { artifactPassportView, type PassportLink } from './artifactModel';

/** How many versions get their content read (newest first). */
const CONTENT_READS = 12;

type Loaded = {
  detail: ArtifactDetail;
  contents: Map<string, VersionContent>;
  subjects: Map<string, string>;
  up: LineageView | null;
  down: LineageView | null;
};

/** Everything the read-only Passport shows, read over nexus:* (and the project's own git log for commit subjects). */
function useArtifactPassport(artifactId: string, shownVersionNo: number, rootPath: string): { loaded: Loaded | null; error: string | null } {
  const rev = usePlatform((s) => s.rev);
  const [state, setState] = useState<{ loaded: Loaded | null; error: string | null }>({ loaded: null, error: null });
  useEffect(() => { setState({ loaded: null, error: null }); }, [artifactId]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await nexusClient.artifactGet(artifactId);
        if (!alive) return;
        if (!d.ok) { setState((s) => ({ loaded: d.code === 'not_found' ? null : s.loaded, error: errorCopy(d.code, d.reason, d.subReason).text })); return; }
        const detail = d.data;
        const newest = [...detail.versions].sort((a, b) => b.versionNo - a.versionNo).slice(0, CONTENT_READS);
        const shown = detail.versions.find((v) => v.versionNo === shownVersionNo) ?? null;
        const [reads, up, down] = await Promise.all([
          Promise.all(newest.map((v) => nexusClient.versionGet(v.id))),
          shown ? nexusClient.lineageGet(shown.id, { direction: 'up', depth: 1 }) : Promise.resolve(null),
          shown ? nexusClient.lineageGet(shown.id, { direction: 'down', depth: 1 }) : Promise.resolve(null)
        ]);
        if (!alive) return;
        const contents = new Map<string, VersionContent>();
        for (const r of reads) if (r.ok) contents.set(r.data.id, r.data.content);
        // Commit subjects come only from the project's own git log: the allow-list for that text.
        const subjects = new Map<string, string>();
        if ([...contents.values()].some((c) => c.type === 'git')) {
          const log = await window.cth.gitLog(rootPath, 200).catch(() => null);
          if (!alive) return;
          if (Array.isArray(log)) for (const c of log) subjects.set(c.sha, c.subject);
        }
        setState({
          loaded: { detail, contents, subjects, up: up && up.ok ? up.data : null, down: down && down.ok ? down.data : null },
          error: (up && !up.ok) || (down && !down.ok) ? 'Some links of this version could not be read.' : null
        });
      } catch {
        // An unexpected throw (for example from the git log read): never an unhandled rejection.
        if (alive) setState((s) => ({ loaded: s.loaded, error: errorCopy('internal').text }));
      }
    })();
    return () => { alive = false; };
  }, [artifactId, shownVersionNo, rootPath, rev]);
  return state;
}

function Links({ title, links, truncated, empty }: { title: string; links: PassportLink[] | null; truncated: boolean; empty: string }) {
  return (
    <section>
      <h2>{title}</h2>
      {links === null ? <p className="nx-muted">Not available.</p> : links.length === 0 ? <p className="nx-muted">{empty}</p> : (
        <ul className="nx-apx__links">
          {links.map((l) => <li key={l.versionId}><span>{l.label}</span> <span className="nx-muted">{l.relation}, {l.status}</span></li>)}
        </ul>
      )}
      {truncated && <p className="nx-muted">More links exist than are shown here.</p>}
    </section>
  );
}

/** The artifact Passport (read-only): the artifact, its versions with their
 *  statuses (the current one marked), what each version holds, and its sources
 *  and uses. Version actions arrive in a later task. */
export function ArtifactPassport({ project, node, artifacts }: { project: { id: string; rootPath: string }; node: ArtifactNode; artifacts: ArtifactSummary[] }) {
  const idx = useParticipationIndex();
  const { loaded, error } = useArtifactPassport(node.artifactId, node.versionNo, project.rootPath);
  const names = useMemo(() => new Map(artifacts.map((s) => [s.artifact.id, s.artifact.name])), [artifacts]);

  const view = useMemo(() => {
    if (!loaded) return null;
    const a = loaded.detail.artifact;
    const row = a.ownerParticipationId ? (idx.byProject.get(project.id) ?? []).find((r) => r.id === a.ownerParticipationId) ?? null : null;
    const owner = a.ownerWorkspaceId ? { label: viewOf(a.ownerWorkspaceId).label, active: row ? row.status === 'active' : true } : null;
    const shown = loaded.detail.versions.find((v) => v.versionNo === node.versionNo) ?? null;
    return artifactPassportView({ detail: loaded.detail, shownVersionId: shown ? shown.id : null, owner, contents: loaded.contents, subjects: loaded.subjects, names, up: loaded.up, down: loaded.down });
  }, [loaded, idx, project.id, node.versionNo, names]);

  if (!view) {
    return (
      <aside className="nx-passport" aria-labelledby="nx-passport-title">
        <header>
          <p className="nx-passport__kind">Artifact</p>
          <h2 id="nx-passport-title" className="nx-passport__title">{node.name}</h2>
        </header>
        {error ? <p className="nx-passport__note" role="alert">{error}</p> : <p className="nx-muted" role="status">Reading the artifact…</p>}
      </aside>
    );
  }
  return (
    <aside className="nx-passport" aria-labelledby="nx-passport-title">
      <header>
        <p className="nx-passport__kind">{view.kind}</p>
        <h2 id="nx-passport-title" className="nx-passport__title">{view.title}</h2>
      </header>
      <section>
        <h2>Artifact</h2>
        <dl>{view.rows.map((r) => <Fragment key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></Fragment>)}</dl>
      </section>
      <section>
        <h2>Versions</h2>
        <ol className="nx-versions">
          {view.versions.map((v) => (
            <li key={v.id} aria-current={v.current ? 'true' : undefined}>
              <span className="nx-id">v{v.versionNo}</span>
              <span className="nx-apx__version">
                <span>{v.status}{v.current ? ', current' : ''}{v.shown && !v.current ? ', shown on the spine' : ''}</span>
                {v.content && <span className="nx-apx__content">{v.content}</span>}
                {v.subject && <span className="nx-muted">{v.subject}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>
      <Links title="Sources" links={view.upstream} truncated={view.upstreamTruncated} empty="No sources recorded for this version." />
      <Links title="Used by" links={view.downstream} truncated={view.downstreamTruncated} empty="Nothing uses this version yet." />
      {error && <p className="nx-passport__note" role="alert">{error}</p>}
    </aside>
  );
}
