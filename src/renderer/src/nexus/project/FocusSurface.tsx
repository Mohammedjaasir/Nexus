import type { Project } from '@shared/project';
import type { ProjectTool } from '../router/routes';
import type { GitState, SpineNode } from './spineModel';
import { SourceView } from './SourceView';
import { CompletionPlaceholder } from './CompletionPlaceholder';
import { ReviewSurface } from '../review/ReviewSurface';
import { ProjectRuns } from '../runs/ProjectRuns';

export function FocusSurface({ tool, project, node, git, onRetryGit }: {
  tool: ProjectTool; project: Project; node: SpineNode; git: GitState; onRetryGit: () => void;
}) {
  if (tool === 'completion') return <CompletionPlaceholder project={project} />;
  if (tool === 'changes') return <ReviewSurface root={project.rootPath} git={git} refresh={onRetryGit} />;
  if (tool === 'runs') return <ProjectRuns projectId={project.id} />;
  return <SourceView project={project} node={node} git={git} onRetry={onRetryGit} />;
}
