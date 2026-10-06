import type { DomainId } from '@shared/domain';
import { useStore } from '@/store/store';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';
import { buildWorkspaceIndex } from './workspaceIndex';
import type { WorkspaceId } from '../workspaces/types';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Workspaces as an index: one row per kind of work, with its real projects
 *  and what is planned. Click a row to open it. */
export function WorkspacesPage() {
  const projects = useStore((s) => s.projects);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const actions = useShellActions();
  const idx = buildWorkspaceIndex(projects);

  const open = (id: WorkspaceId) => {
    setLast(id);
    navigate({ name: 'workspace', id });
  };

  return (
    <div className="nx-page nx-wsx">
      <header className="nx-wsx__head">
        <div className="nx-wsx__title">
          <h1 tabIndex={-1}>Workspaces</h1>
          <p>
            {plural(idx.rows.length, 'workspace')} · {plural(idx.totalProjects, 'project')}
            {idx.unassigned > 0 && <> · <button type="button" className="nx-wsx__link" onClick={() => navigate({ name: 'projects' })}>{idx.unassigned} unassigned</button></>}
          </p>
        </div>
        <button type="button" className="nx-wsx__new" onClick={() => actions.openNewProject()}>New project</button>
      </header>

      <ul className="nx-wsx__list" aria-label="Workspaces">
        {idx.rows.map((r) => (
          <li key={r.id} className="nx-wsx__row" style={provenanceStyle(r.ws.hueSlot)}>
            <button type="button" className="nx-wsx__open" onClick={() => open(r.id)} aria-label={`Open ${r.ws.name}`}>
              <span className="nx-wsx__name">
                <i aria-hidden="true" />
                <b>{r.ws.name}</b>
                <small>{r.ws.tagline}</small>
              </span>
              <span className="nx-wsx__desc">{r.ws.description}</span>
              <span className="nx-wsx__projects" title={r.hasDomain ? `Projects detected as: ${r.ws.domainIds.join(', ')}` : undefined}>
                {r.count > 0 ? (
                  <>
                    <b>{plural(r.count, 'project')}</b>
                    <small>{r.recent.map((p) => p.name).join(', ')}{r.count > r.recent.length ? ', …' : ''}</small>
                  </>
                ) : (
                  <>
                    <b className="is-empty">No projects yet</b>
                    <small>{r.hasDomain ? 'New projects of this kind land here' : 'No detected domain maps here yet'}</small>
                  </>
                )}
              </span>
              <span className="nx-wsx__planned">
                {r.ws.plannedModules.length > 0 && <><small>Planned</small>{r.ws.plannedModules.join(' · ')}</>}
              </span>
              <span className="nx-wsx__chev" aria-hidden="true">→</span>
            </button>
            <button type="button" className="nx-wsx__add" onClick={() => actions.openNewProject(r.ws.defaultDomainId as DomainId | undefined)}
              aria-label={`New ${r.ws.label} project`} title={`New ${r.ws.label} project`}>+</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
