import { useEffect, useState } from 'react';
import type { DomainId } from '@shared/domain';
import type { Project } from '@shared/project';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { useStore } from '../store/store';
import { ProjectSummaryCard } from './ProjectSummaryCard';
import { ProjectImportModal } from './ProjectImportModal';

export interface ProjectDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Start the new-project wizard (owned by the caller). */
  onNewProject?: () => void;
  /** Open the selected project's view; defaults to just closing. */
  onOpenProject?: () => void;
}

export function ProjectDashboardModal({ isOpen, onClose, onNewProject, onOpenProject }: ProjectDashboardModalProps) {
  const activeProject = useStore((s) => s.activeProject);
  const setActiveProject = useStore((s) => s.setActiveProject);
  const projects = useStore((s) => s.projects);
  const setProjects = useStore((s) => s.setProjects);

  const [importOpen, setImportOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // Load project list on mount
  useEffect(() => {
    if (isOpen) {
      window.cth.projectList().then((list) => {
        setProjects(list);
        if (!activeProject && list.length > 0) {
          window.cth.projectGetActive().then((act) => {
            if (act) setActiveProject(act);
            else if (list[0]) {
              window.cth.projectSetActive(list[0].id).then(setActiveProject);
            }
          });
        }
      });
    }
  }, [isOpen, activeProject, setActiveProject, setProjects]);

  if (!isOpen) return null;

  const currentProject = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId) ?? activeProject
    : activeProject ?? projects[0] ?? null;

  const handleSelectProject = async (p: Project) => {
    setSelectedProjectId(p.id);
    const updated = await window.cth.projectSetActive(p.id);
    if (updated) {
      setActiveProject(updated);
    }
  };

  const handleRefreshActive = async () => {
    if (!currentProject) return;
    setRefreshing(true);
    try {
      const refreshed = await window.cth.projectRefresh(currentProject.id);
      if (refreshed) {
        setActiveProject(refreshed);
        const list = await window.cth.projectList();
        setProjects(list);
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleChangeDomain = async (newDomain: DomainId) => {
    if (!currentProject) return;
    const updated = await window.cth.projectUpdate(currentProject.id, { domainId: newDomain });
    if (updated) {
      setActiveProject(updated);
      const list = await window.cth.projectList();
      setProjects(list);
    }
  };

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(23, 20, 16, 0.75)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 250,
          padding: 24
        }}
      >
        <div style={{ width: 840, maxWidth: '96vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
          <PixelPanel
            variant="dialog"
            noPadding
            style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
          >
            {/* Title Bar */}
            <div
              style={{
                padding: '10px 16px',
                background: 'var(--cth-cream-200)',
                borderBottom: '1.5px solid var(--cth-ink-900)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}
            >
              <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                PROJECT WORKSPACE DASHBOARD
              </span>
              <button
                onClick={onClose}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 16,
                  lineHeight: 1,
                  padding: '2px 6px',
                  color: 'var(--cth-ink-700)'
                }}
              >
                ✕
              </button>
            </div>
            {/* Top Toolbar */}
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1.5px solid var(--cth-ink-200)',
                background: 'var(--cth-cream-100)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}
            >
              <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                ACTIVE PROJECTS ({projects.length})
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {onNewProject && (
                  <PixelButton variant="secondary" size="sm" onClick={onNewProject}>
                    + New Project
                  </PixelButton>
                )}
                <PixelButton variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                  + Import Existing Project
                </PixelButton>
              </div>
            </div>

            {/* Content Area */}
            <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Project selector strip */}
              {projects.length > 1 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingBottom: 4 }}>
                  {projects.map((p) => {
                    const isSelected = (currentProject?.id === p.id);
                    return (
                      <button
                        key={p.id}
                        onClick={() => handleSelectProject(p)}
                        style={{
                          padding: '6px 12px',
                          background: isSelected ? 'var(--cth-mint-light)' : 'var(--cth-cream-100)',
                          boxShadow: isSelected
                            ? 'inset 0 0 0 2px var(--cth-mint)'
                            : 'inset 0 0 0 1px var(--cth-ink-200)',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'var(--cth-font-ui)',
                          fontSize: 12,
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {isSelected ? '● ' : ''}{p.name}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Main Project Summary View */}
              {currentProject ? (
                <ProjectSummaryCard
                  project={currentProject}
                  onOpenProject={onOpenProject ?? onClose}
                  onRefreshProject={handleRefreshActive}
                  onChangeDomain={handleChangeDomain}
                  isRefreshing={refreshing}
                />
              ) : (
                <div
                  style={{
                    padding: 32,
                    textAlign: 'center',
                    background: 'var(--cth-cream-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
                  }}
                >
                  <p style={{ fontFamily: 'var(--cth-font-display)', fontSize: 13, marginBottom: 12 }}>
                    No Projects Configured Yet
                  </p>
                  <p style={{ fontSize: 12, color: 'var(--cth-ink-500)', maxWidth: 460, margin: '0 auto 16px' }}>
                    Import an existing repository or workspace folder to unlock domain-specialized AI agent environments.
                  </p>
                  <PixelButton variant="primary" onClick={() => setImportOpen(true)}>
                    Import Existing Project Now →
                  </PixelButton>
                </div>
              )}
            </div>
          </PixelPanel>
        </div>
      </div>

      <ProjectImportModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onImportSuccess={() => {
          window.cth.projectList().then(setProjects);
        }}
      />
    </>
  );
}
