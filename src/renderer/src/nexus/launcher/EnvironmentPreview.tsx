import type { CSSProperties } from 'react';
import { useStore } from '@/store/store';
import { getWorkspace } from '../workspaces/registry';
import { projectsForWorkspace } from '../workspaces/mapping';
import { recentProjects, relativeTime } from '../data/selectors';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { Button } from '../ui/Button';
import { emblemPath } from './emblems';
import { PreviewStars } from './PreviewStars';

/** The environment's emblem. The path element persists across selections and
 *  its `d` is set as a CSS property, so the browser morphs one shape into the
 *  next (every emblem has the same point count; see emblems.ts). */
function Emblem({ id }: { id: string }) {
  const d = { d: `path("${emblemPath(id)}")` } as CSSProperties;
  return (
    <div className="nx-emblem" aria-hidden="true">
      <svg viewBox="0 0 100 100" className="nx-emblem__svg">
        <circle className="nx-emblem__orbit" cx={50} cy={50} r={46} />
        <g className="nx-emblem__sats">
          <circle cx={50} cy={4} r={2.4} />
          <circle cx={96} cy={50} r={1.6} />
          <circle cx={18} cy={82} r={1.9} />
        </g>
        <path className="nx-emblem__glow" style={d} />
        <path className="nx-emblem__shape" style={d} />
        <path className="nx-emblem__shine" style={d} />
      </svg>
    </div>
  );
}

export function EnvironmentPreview({ id }: { id: string | null }) {
  const projects = useStore((s) => s.projects);
  const actions = useShellActions();
  const ws = id ? getWorkspace(id) : null;
  if (!ws) return <aside className="nx-preview" aria-live="polite"><p className="nx-muted">No environment matches.</p></aside>;
  const mine = recentProjects(projectsForWorkspace(projects, ws.id), 5);
  const now = Date.now();
  return (
    <aside className="nx-preview nx-prov" style={provenanceStyle(ws.hueSlot)} aria-labelledby="nx-preview-name">
      <p className="nx-visually-hidden" role="status" aria-live="polite">{ws.name}</p>
      <PreviewStars />
      <Emblem id={ws.id} />
      {/* Keyed so the text re-enters for each environment; the emblem above
          is not keyed, so it morphs instead of re-mounting. */}
      <div key={ws.id} className="nx-preview__body">
        <p className="nx-preview__kicker">Environment</p>
        <h2 id="nx-preview-name" className="nx-preview__name">{ws.name}</h2>
        <p className="nx-preview__desc">{ws.description}</p>
        <div className="nx-preview__block"><p className="nx-preview__kicker">Works with</p>
          <ul className="nx-vocab">{ws.plannedModules.map((m, i) => <li key={m} style={{ ['--i' as string]: i } as CSSProperties}>{m}</li>)}</ul></div>
        <div className="nx-preview__block"><p className="nx-preview__kicker">Your projects here</p>
          {mine.length ? (
            <ul className="nx-preview__projects">{mine.map((p) => (
              <li key={p.id}><button type="button" className="nx-linkrow" onClick={() => navigate({ name: 'project', id: p.id, tool: 'bench' })}>
                <span className="nx-linkrow__name">{p.name}</span><span className="nx-muted">{relativeTime(p.updatedAt, now)}</span></button></li>))}
            </ul>
          ) : <p className="nx-muted">No {ws.label} projects yet. Create one, or import a folder and Nexus files it here when its domain matches.</p>}
        </div>
        <div className="nx-actions">
          <Button variant="primary" onClick={() => navigate({ name: 'workspace', id: ws.id })}>Open {ws.label}</Button>
          <Button onClick={() => actions.openNewProject(ws.defaultDomainId)}>New project</Button>
        </div>
      </div>
    </aside>
  );
}
