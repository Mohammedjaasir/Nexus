import { useStore } from '@/store/store';
import { getWorkspace } from '../workspaces/registry';
import { projectsForWorkspace } from '../workspaces/mapping';
import { recentProjects, relativeTime } from '../data/selectors';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { Button } from '../ui/Button';

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
      <p className="nx-preview__kicker">Environment</p>
      <h2 id="nx-preview-name" className="nx-preview__name">{ws.name}</h2>
      <p className="nx-preview__desc">{ws.description}</p>
      <div className="nx-preview__block"><p className="nx-preview__kicker">Works with</p>
        <ul className="nx-vocab">{ws.plannedModules.map((m) => <li key={m}>{m}</li>)}</ul></div>
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
    </aside>
  );
}
