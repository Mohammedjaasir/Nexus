import type { Project } from '@shared/project';
import type { ProjectTool } from '../router/routes';
import type { GitState, SpineNode } from './spineModel';
import { SourceView } from './SourceView';
import { LegacyPlanHost } from './LegacyPlanHost';

type Head = Extract<GitState, { status: 'ready' }>['head'];

export function FocusSurface({ tool, project, node, head, onRetryGit, onRefreshProject }: {
  tool: ProjectTool; project: Project; node: SpineNode; head: Head; onRetryGit: () => void; onRefreshProject: () => void;
}) {
  if (tool === 'plan') {
    return <section className="nx-surface nx-surface--legacy" aria-label="Plan"><LegacyPlanHost project={project} onRefreshProject={onRefreshProject} /></section>;
  }
  if (tool === 'changes') {
    return (
      <section className="nx-surface" aria-labelledby="nx-surface-title">
        <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>Changes</h1>
        <p className="nx-muted" role="status">Change review arrives in the next step.</p>
      </section>
    );
  }
  if (tool === 'runs') {
    return (
      <section className="nx-surface" aria-labelledby="nx-surface-title">
        <h1 id="nx-surface-title" className="nx-surface__title" tabIndex={-1}>Runs</h1>
        <p className="nx-muted" role="status">Runs arrive in the next step.</p>
      </section>
    );
  }
  return <SourceView project={project} node={node} head={head} onRetry={onRetryGit} />;
}
