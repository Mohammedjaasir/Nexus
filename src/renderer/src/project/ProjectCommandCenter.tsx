import { useState } from 'react';
import type { Project } from '@shared/project';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { ProjectCompletionPanel } from './ProjectCompletionPanel';
import { ProjectGoalCard } from './ProjectGoalCard';
import { ProjectGapsCard } from './ProjectGapsCard';
import { ProjectPlanCard } from './ProjectPlanCard';
import { OfficeFloor } from '../scene/office/OfficeFloor';

export interface ProjectCommandCenterProps {
  project: Project;
  onBackToHome: () => void;
  onRefreshProject?: () => void;
  /** Hosted inside Nexus: omit the "Floor Office View" tab and its panel. */
  hideFloorTab?: boolean;
}

export function ProjectCommandCenter({ project, onBackToHome, onRefreshProject, hideFloorTab }: ProjectCommandCenterProps) {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'office'>('dashboard');

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
          <div style={{ display: 'flex', background: 'var(--cth-ink-100)', padding: 2, borderRadius: 2 }}>
            <button
              type="button"
              onClick={() => setActiveTab('dashboard')}
              style={{
                padding: '4px 10px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                background: activeTab === 'dashboard' ? '#fff' : 'transparent',
                color: 'var(--cth-ink-900)',
                cursor: 'pointer'
              }}
            >
              Command Center
            </button>
            {!hideFloorTab && <button
              type="button"
              onClick={() => setActiveTab('office')}
              style={{
                padding: '4px 10px',
                fontSize: 10,
                fontWeight: 700,
                border: 'none',
                background: activeTab === 'office' ? '#fff' : 'transparent',
                color: 'var(--cth-ink-900)',
                cursor: 'pointer'
              }}
            >
              Floor Office View
            </button>}
          </div>

          <PixelButton variant="secondary" size="sm" onClick={onRefreshProject}>
            Refresh ⟳
          </PixelButton>
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {activeTab === 'dashboard' || hideFloorTab ? (
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
        ) : (
          <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            <OfficeFloor />
          </div>
        )}
      </div>
    </div>
  );
}
