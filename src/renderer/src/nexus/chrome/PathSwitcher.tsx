import type { Project } from '@shared/project';
import { navigate } from '../router/useRoute';
import type { ProjectTool } from '../router/routes';
import { useNexusUi } from '../state/uiStore';
import { WORKSPACES } from '../workspaces/registry';
import { projectsInWorkspace, type ParticipationIndex } from '../workspaces/participation';
import type { WorkspaceId } from '../workspaces/types';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { Popover } from '../ui/Sheet';
import type { PathSegment } from './navItems';

/** One path segment in the context bar. Opens a listbox of its real siblings:
 *  a workspace segment lists every workspace; a project segment lists the
 *  projects of its workspace (all projects when the workspace is Unassigned). */
export function PathSwitcher({ segment, workspaceId, projects, idx, tool }: {
  segment: PathSegment;
  /** For a project segment: the id of the workspace segment before it. */
  workspaceId?: string;
  projects: Project[];
  /** Which workspaces each project takes part in. */
  idx: ParticipationIndex;
  /** The current project tool, kept when switching projects. */
  tool?: ProjectTool;
}) {
  const setLastWorkspace = useNexusUi((s) => s.setLastWorkspace);
  const isWs = segment.kind === 'workspace';
  const label = isWs ? 'Workspaces' : 'Projects';

  return (
    <Popover
      kind="listbox"
      label={label}
      triggerLabel={`${segment.label}, switch ${isWs ? 'workspace' : 'project'}`}
      triggerClassName="nx-path__seg"
      trigger={<>{isWs && <ProvenanceMark slot={segment.hueSlot} />}<span className="nx-path__label">{segment.label}</span></>}
    >
      {(close) => {
        if (isWs) {
          return WORKSPACES.map((w) => (
            <button key={w.id} type="button" role="option" tabIndex={-1} aria-selected={w.id === segment.id} className="nx-menu__item"
              onClick={() => { close(); setLastWorkspace(w.id); navigate({ name: 'workspace', id: w.id }); }}>
              <ProvenanceMark slot={w.hueSlot} />
              <span className="nx-menu__text">{w.label}</span>
            </button>
          ));
        }
        const list = !workspaceId || workspaceId === 'unassigned'
          ? projects
          : projectsInWorkspace(idx, projects, workspaceId as WorkspaceId).map((x) => x.project);
        if (list.length === 0) {
          return <div role="option" aria-disabled="true" aria-selected="false" className="nx-menu__empty">No projects here</div>;
        }
        return list.map((p) => (
          <button key={p.id} type="button" role="option" tabIndex={-1} aria-selected={p.id === segment.id} className="nx-menu__item"
            onClick={() => { close(); navigate({ name: 'project', id: p.id, tool: tool ?? 'bench' }); }}>
            <span className="nx-menu__text">{p.name}</span>
          </button>
        ));
      }}
    </Popover>
  );
}
