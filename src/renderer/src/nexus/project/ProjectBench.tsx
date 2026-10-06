import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Project } from '@shared/project';
import { useStore } from '@/store/store';
import type { ProjectTool } from '../router/routes';
import { navigate } from '../router/useRoute';
import { useProjectsLoader } from '../data/useProjects';
import { useNexusUi } from '../state/uiStore';
import { EmptyState } from '../ui/EmptyState';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { useMedia } from '../ui/useMedia';
import { withViewTransition } from '../ui/viewTransition';
import { MobileRuns } from './MobileRuns';
import { buildSpine, nodeLabel } from './spineModel';
import type { SpineNode } from './spineModel';
import { useProjectGit } from './useProjectGit';
import { Spine } from './Spine';
import { ToolRail } from './ToolRail';
import { FocusSurface } from './FocusSurface';
import { Passport } from './PassportPanel';

/** The project route: opens the project, then shows the Spine workbench. */
export function ProjectBench({ id, tool }: { id: string; tool: ProjectTool }) {
  const { status, error: loadError, refresh: reloadProjects } = useProjectsLoader();
  const projectCount = useStore((s) => s.projects.length);
  const known = useStore((s) => s.projects.find((p) => p.id === id) ?? null);
  const active = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A new project id starts clean: no error carried over from another project.
  useEffect(() => { setErr(null); }, [id]);

  useEffect(() => {
    if (!known || active?.id === id) return;
    let alive = true;
    setErr(null);
    window.cth.projectSetActive(id)
      .then((p) => { if (alive) { if (p) setActiveProject(p); else setErr('The project could not be opened.'); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, known, active?.id, setActiveProject, attempt]);

  if (!known && status === 'error' && projectCount === 0) {
    return <div className="nx-page"><EmptyState level={1} icon="refresh" title="Couldn't load your projects" body={loadError ?? 'The project list could not be loaded.'} actions={<Button variant="primary" onClick={() => { void reloadProjects(); }}>Retry</Button>} /></div>;
  }
  if (!known && status !== 'loading') {
    return <div className="nx-page"><EmptyState level={1} icon="projects" title="That project isn't in your list" body="It may have been removed. Open Projects to pick another."
      actions={<Button variant="primary" onClick={() => navigate({ name: 'projects' })}>Back to Projects</Button>} /></div>;
  }
  if (err) {
    return <div className="nx-page"><EmptyState level={1} icon="refresh" title="Couldn't open the project" body={err} actions={<Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>} /></div>;
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

  const wide = !useMedia('(max-width: 1279px)');
  const mobile = useMedia('(max-width: 767px)');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  useEffect(() => {
    if (!wide) return;
    setDetailsOpen((open) => {
      // Widening with the sheet open: focus would otherwise drop to body.
      if (open) setTimeout(() => document.getElementById('nx-surface-title')?.focus(), 0);
      return false;
    });
  }, [wide]);

  // The clicked node carries the shared transition name only for this one
  // transition; the surface title carries it in steady state. The router is
  // hash-based, so the hashchange is dispatched synchronously inside flushSync
  // and the new snapshot shows the rendered surface.
  const onSelect = (nodeId: string, el?: HTMLElement) => {
    const root = document.documentElement;
    // Old snapshot: only the node is named (the surface title is suppressed).
    root.dataset.nxVt = '1';
    el?.style.setProperty('view-transition-name', 'nx-focus');
    withViewTransition(() => {
      // New snapshot: only the title is named. Cleared on every path.
      delete root.dataset.nxVt;
      el?.style.removeProperty('view-transition-name');
      flushSync(() => {
        setSelected(nodeId);
        navigate({ name: 'project', id: project.id, tool: nodeId === 'changes' ? 'changes' : 'bench' });
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    });
  };

  const refreshProject = useCallback(async () => {
    const r = await window.cth.projectRefresh(project.id);
    if (r) setActiveProject(r);
    refresh();
  }, [project.id, setActiveProject, refresh]);

  const head = git.status === 'ready' ? git.head : null;
  const [notice, setNotice] = useState<string | null>(null);
  const openTerminal = useCallback(() => {
    setNotice(null);
    window.cth.openTerminalAt(project.rootPath)
      .then((r) => { if (!r.ok) setNotice(r.error ?? 'The terminal could not be opened.'); })
      .catch((e) => setNotice(e instanceof Error ? e.message : String(e)));
  }, [project.rootPath]);
  // The sheet's Passport unmounts when the sheet closes, so its own error line
  // cannot show a failed refresh: route it to the bench-level notice instead.
  const refreshFromSheet = useCallback(() => {
    setNotice(null);
    return refreshProject().catch((e) => setNotice(e instanceof Error ? e.message : String(e)));
  }, [refreshProject]);
  return (
    <div className="nx-workbench">
      {mobile && <MobileRuns projectId={project.id} />}
      <Spine groups={groups} selectedId={tool === 'completion' || tool === 'runs' ? '' : node.id} onSelect={onSelect} />
      <div className="nx-bench">
        <ToolRail projectId={project.id} rootPath={project.rootPath} tool={tool} hasChanges={hasChanges} onOpenTerminal={openTerminal}
          extra={!wide && (
            <button type="button" className="nx-passport-btn" aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)}>Details</button>
          )} />
        {!wide && notice && <p className="nx-passport__note" role="alert">{notice}</p>}
        <FocusSurface tool={tool} project={project} node={sourceNode} git={git} onRetryGit={refresh} />
        {wide && <Passport project={project} node={node} headSha={head?.sha ?? null} onRefreshProject={refreshProject} onOpenTerminal={openTerminal} notice={notice} />}
      </div>
      {!wide && (
        <Sheet open={detailsOpen} onClose={closeDetails} side={mobile ? 'bottom' : 'right'} labelledBy="nx-passport-title">
          <Passport project={project} node={node} headSha={head?.sha ?? null} onRefreshProject={refreshFromSheet} onOpenTerminal={openTerminal} notice={null} onBeforeAction={closeDetails} />
        </Sheet>
      )}
    </div>
  );
}
