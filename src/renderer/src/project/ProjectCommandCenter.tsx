import type { Project } from '@shared/project';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { ProjectCompletionPanel } from './ProjectCompletionPanel';
import { ProjectGoalCard } from './ProjectGoalCard';
import { ProjectGapsCard } from './ProjectGapsCard';
import { ProjectPlanCard } from './ProjectPlanCard';

export interface ProjectCommandCenterProps {
  project: Project;
  onBackToHome: () => void;
  onRefreshProject?: () => void;
}

export function ProjectCommandCenter({ project, onBackToHome, onRefreshProject }: ProjectCommandCenterProps) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--cth-cream-100)' }}>
      {/* Top Command Bar */}
      <div
        style={{
          padding: '10px 16px',
          background: '#fff',
          borderBottom: '1px solid var(--cth-ink-200)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexShrink: 0
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <PixelButton variant="secondary" size="sm" onClick={onBackToHome}>
            ← Projects Home
          </PixelButton>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
              {project.name}
            </span>
            <span
              style={{
                fontSize: 9,
                fontFamily: 'monospace',
                padding: '2px 6px',
                background: 'var(--cth-ink-100)',
                color: 'var(--cth-ink-800)',
                borderRadius: 2
              }}
            >
              {project.domainId.toUpperCase()}
            </span>
          </div>
          <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
            ({project.rootPath})
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PixelButton variant="secondary" size="sm" onClick={onRefreshProject}>
            Refresh ⟳
          </PixelButton>
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Phase 9A / 9B Verified Execution Coordinator */}
            <ProjectCompletionPanel projectId={project.id} />

            {/* Phase 8C Project Goal & Target Capabilities */}
            <ProjectGoalCard projectId={project.id} />

            {/* Phase 8B State-Aware Gap Analysis */}
            <ProjectGapsCard projectId={project.id} />

            {/* Phase 8A Milestone & Task DAG Graph */}
            <ProjectPlanCard projectId={project.id} />
          </div>
      </div>
    </div>
  );
}
