import type { Project } from '@shared/project';
import type { ProjectTool } from '../router/routes';
import type { GitState, SpineNode } from './spineModel';
import { SourceView } from './SourceView';
import { LegacyPlanHost } from './LegacyPlanHost';

export function FocusSurface({ tool, project, node, git, onRetryGit, onRefreshProject }: {
  tool: ProjectTool; project: Project; node: SpineNode; git: GitState; onRetryGit: () => void; onRefreshProject: () => void;
}) {
  if (tool === 'plan') {
    return (
      <section className="nx-surface nx-surface--legacy" aria-labelledby="nx-surface-title">
        <h1 id="nx-surface-title" className="nx-visually-hidden" tabIndex={-1}>Plan</h1>
        <LegacyPlanHost project={project} onRefreshProject={onRefreshProject} />
      </section>
    );
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
  return <SourceView project={project} node={node} git={git} onRetry={onRetryGit} />;
}
