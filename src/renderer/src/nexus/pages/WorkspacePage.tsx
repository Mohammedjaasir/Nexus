// WorkspacePage.tsx
import { useStore } from '@/store/store';
import type { WorkspaceId } from '../workspaces/types';
import { getWorkspace } from '../workspaces/registry';
import { projectsForWorkspace } from '../workspaces/mapping';
import { recentProjects } from '../data/selectors';
import { useProjectsLoader } from '../data/useProjects';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { ProjectRow } from '../components/ProjectRow';
import { LoadError, RowsSkeleton } from '../components/LoadStates';

export function WorkspacePage({ id }: { id: WorkspaceId }) {
  const ws = getWorkspace(id)!; // route parsing guarantees a known id
  const projects = useStore((s) => s.projects);
  const { status, error, refresh } = useProjectsLoader();
  const actions = useShellActions();
  const mine = recentProjects(projectsForWorkspace(projects, id), Infinity);
  const unmappable = ws.domainIds.length === 0;
  return (
    <div className="nx-page">
      <header className="nx-pagehead">
        <div className="nx-pagehead__text">
          <h1 tabIndex={-1}><ProvenanceMark slot={ws.hueSlot} size={10} /> {ws.name}</h1>
          <p className="nx-lead">{ws.description}</p>
        </div>
        <div className="nx-pagehead__actions">
          <Button variant="primary" icon="plus" onClick={() => actions.openNewProject(ws.defaultDomainId)}>New project</Button>
        </div>
      </header>
      <section aria-labelledby="ws-projects">
        <h2 id="ws-projects" className="nx-h2">Projects in {ws.label}</h2>
        {status === 'error' && projects.length === 0 ? <LoadError error={error} onRetry={refresh} />
          : status === 'loading' && projects.length === 0 ? <RowsSkeleton count={3} />
          : mine.length > 0 ? <div className="nx-rows">{mine.map((p) => <ProjectRow key={p.id} project={p} onOpen={() => navigate({ name: 'project', id: p.id, tool: 'bench' })} />)}</div>
          : unmappable ? (
            <EmptyState icon={ws.icon} title={`No ${ws.label} projects yet`}
              body={<>Projects are grouped by the domain the analyzer detects, and none map to {ws.label} today. {ws.label} work will arrive through handoffs in a later phase.</>}
              actions={<Button onClick={() => navigate({ name: 'projects' })}>See all projects</Button>} />
          ) : (
            <EmptyState icon={ws.icon} title={`No ${ws.label} projects yet`} body="Create one here, or import a folder; it joins this workspace when its domain matches."
              actions={<><Button variant="primary" icon="plus" onClick={() => actions.openNewProject(ws.defaultDomainId)}>New project</Button><Button icon="import" onClick={actions.openImport}>Import</Button></>} />
          )}
      </section>
      <section aria-labelledby="ws-planned">
        <h2 id="ws-planned" className="nx-h2">Coming to this workspace</h2>
        <div className="nx-chips">{ws.plannedModules.map((m) => <span key={m} className="nx-chip">{m} <Badge>Planned</Badge></span>)}</div>
      </section>
    </div>
  );
}
