import { useState } from 'react';
import { useStore } from '@/store/store';
import { recentProjects, relativeTime } from '../data/selectors';
import { useProjectsLoader } from '../data/useProjects';
import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { IconTile } from '../ui/IconTile';
import { Icon } from '../icons';
import { Button } from '../ui/Button';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState } from '../ui/EmptyState';
import { RepoHealthBar } from '../components/RepoHealthBar';
import { LoadError } from '../components/LoadStates';

export function RecentProjects() {
  const projects = useStore((s) => s.projects);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const { status, error, refresh } = useProjectsLoader();
  const actions = useShellActions();
  const [menu, setMenu] = useState<string | null>(null);
  const recent = recentProjects(projects, 4);
  const now = Date.now();

  return (
    <section className="nx-recent" aria-labelledby="nx-recent-h">
      <div className="nx-recent__head">
        <h2 id="nx-recent-h" className="nx-h2">Recent projects</h2>
        <button type="button" className="nx-iconbtn nx-focusable" onClick={() => navigate({ name: 'projects' })} aria-label="All projects"><Icon name="chevronRight" /></button>
      </div>
      {status === 'error' && projects.length === 0 ? <LoadError error={error} onRetry={refresh} />
        : status === 'loading' && projects.length === 0 ? <div className="nx-recent__row">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="nx-skel-card" />)}</div>
        : recent.length === 0 ? (
          <EmptyState icon="projects" title="No projects yet" body="Create a project or import a folder to start working with your agents."
            actions={<><Button variant="primary" icon="plus" onClick={() => actions.openNewProject()}>New project</Button><Button icon="import" onClick={actions.openImport}>Import</Button></>} />
        ) : (
          <ul className="nx-recent__row">
            {recent.map((p) => {
              const ws = workspaceForDomain(p.domainId);
              return (
                <li key={p.id} className="nx-pcard">
                  <button type="button" className="nx-pcard__open nx-focusable" onClick={() => navigate({ name: 'project', id: p.id, tool: 'bench' })}>
                    <IconTile icon={ws?.icon ?? 'projects'} hue={ws?.hue ?? 'slate'} size="md" />
                    <span className="nx-pcard__text" title={`${p.name} · ${p.rootPath}`}>
                      <span className="nx-pcard__name">{p.name}</span>
                      <span className="nx-pcard__ws">{ws ? `${ws.label} workspace` : `${UNASSIGNED_LABEL} workspace`}</span>
                    </span>
                  </button>
                  <RepoHealthBar project={p} />
                  <span className="nx-pcard__time">Updated {relativeTime(p.updatedAt, now)}</span>
                  <div className="nx-pcard__menu">
                    <button type="button" className="nx-iconbtn nx-focusable" aria-haspopup="menu" aria-expanded={menu === p.id} aria-label={`More for ${p.name}`} onClick={() => setMenu(menu === p.id ? null : p.id)}><Icon name="more" size={17} /></button>
                    {menu === p.id && (
                      <div className="nx-menu" role="menu" onKeyDown={(e) => { if (e.key === 'Escape') setMenu(null); }}>
                        <button role="menuitem" type="button" onClick={() => { setMenu(null); navigate({ name: 'project', id: p.id, tool: 'bench' }); }}>Open</button>
                        <button role="menuitem" type="button" onClick={async () => { setMenu(null); const a = await window.cth.projectSetActive(p.id); if (a) setActiveProject(a); navigate({ name: 'agents' }); }}>Open in Agents view</button>
                        <button role="menuitem" type="button" onClick={async () => { setMenu(null); const r = await window.cth.projectRefresh(p.id); if (r) await refresh(); }}>Refresh analysis</button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
