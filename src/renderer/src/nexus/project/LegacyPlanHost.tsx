import type { Project } from '@shared/project';
import { ProjectCommandCenter } from '@/project/ProjectCommandCenter';
import { navigate } from '../router/useRoute';

/** The plan tool: the existing Command Center, without its office tab. */
export function LegacyPlanHost({ project, onRefreshProject }: { project: Project; onRefreshProject: () => void }) {
  return (
    <div className="nx-legacy-host">
      <ProjectCommandCenter
        project={project}
        hideFloorTab
        onBackToHome={() => navigate({ name: 'projects' })}
        onRefreshProject={onRefreshProject}
      />
    </div>
  );
}
