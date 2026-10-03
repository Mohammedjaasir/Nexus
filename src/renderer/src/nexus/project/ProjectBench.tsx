import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project } from '@shared/project';
import { useStore } from '@/store/store';
import type { ProjectTool } from '../router/routes';
import { navigate } from '../router/useRoute';
import { useProjectsLoader } from '../data/useProjects';
import { useNexusUi } from '../state/uiStore';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { buildSpine, nodeLabel } from './spineModel';
import type { SpineNode } from './spineModel';
import { useProjectGit } from './useProjectGit';
import { Spine } from './Spine';
import { ToolRail } from './ToolRail';
import { FocusSurface } from './FocusSurface';
import { Passport } from './PassportPanel';

/** The project route: opens the project, then shows the Spine workbench. */
export function ProjectBench({ id, tool }: { id: string; tool: ProjectTool }) {
  const { status } = useProjectsLoader();
  const known = useStore((s) => s.projects.find((p) => p.id === id) ?? null);
  const active = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!known || active?.id === id) return;
    let alive = true;
    setErr(null);
    window.cth.projectSetActive(id)
      .then((p) => { if (alive) { if (p) setActiveProject(p); else setErr('The project could not be opened.'); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, known, active?.id, setActiveProject, attempt]);

  if (!known && status !== 'loading') {
    return <div className="nx-page"><EmptyState icon="projects" title="That project isn't in your list" body="It may have been removed. Open Projects to pick another."
      actions={<Button variant="primary" onClick={() => navigate({ name: 'projects' })}>Back to Projects</Button>} /></div>;
  }
  if (err) {
    return <div className="nx-page"><EmptyState icon="refresh" title="Couldn't open the project" body={err} actions={<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>} /></div>;
  }
  if (!active || active.id !== id) {
    return <div className="nx-page"><p className="nx-muted" role="status">Opening {known?.name ?? 'project'}…</p></div>;
  }
  return <Workbench key={active.id} project={active} tool={tool} />;
}

function Workbench({ project, tool }: { project: Project; tool: ProjectTool }) {
  const setActiveProject = useStore((s) => s.setActiveProject);
  const setLastProject = useNexusUi((s) => s.setLastProject);
  const setSelection = useNexusUi((s) => s.setSelection);
  const { git, refresh } = useProjectGit(project.rootPath);
  const groups = useMemo(() => buildSpine({ domainId: project.domainId, git }), [project.domainId, git]);
  const nodes = groups.flatMap((g) => g.nodes);
  const [selected, setSelected] = useState<string>(tool === 'changes' ? 'changes' : 'source');

  // The project opened successfully: remember it for the launcher.
  useEffect(() => { setLastProject(project.id); }, [project.id, setLastProject]);

  // Follow the URL: the changes tool selects the changes node, the bench selects source.
  useEffect(() => {
    if (tool === 'changes') setSelected('changes');
    else if (tool === 'bench') setSelected('source');
  }, [tool]);

  const node: SpineNode = nodes.find((n) => n.id === selected) ?? nodes[0];
  const sourceNode = nodes.find((n) => n.kind === 'source') ?? nodes[0];
  const hasChanges = nodes.some((n) => n.kind === 'changes');
  const label = nodeLabel(node);

  useEffect(() => { setSelection({ kind: node.kind, label }); }, [node.kind, label, setSelection]);
  useEffect(() => () => setSelection(null), [setSelection]);

  const onSelect = (nodeId: string) => {
    setSelected(nodeId);
    navigate({ name: 'project', id: project.id, tool: nodeId === 'changes' ? 'changes' : 'bench' });
  };

  const refreshProject = useCallback(async () => {
    const r = await window.cth.projectRefresh(project.id);
    if (r) setActiveProject(r);
    refresh();
  }, [project.id, setActiveProject, refresh]);

  const head = git.status === 'ready' ? git.head : null;
  return (
    <div className="nx-workbench">
      <Spine groups={groups} selectedId={node.id} onSelect={onSelect} />
      <div className="nx-bench">
        <ToolRail projectId={project.id} rootPath={project.rootPath} tool={tool} hasChanges={hasChanges} />
        <FocusSurface tool={tool} project={project} node={sourceNode} head={head} onRetryGit={refresh} onRefreshProject={refreshProject} />
        <Passport project={project} node={node} headSha={head?.sha ?? null} onRefreshProject={refreshProject} />
      </div>
    </div>
  );
}
