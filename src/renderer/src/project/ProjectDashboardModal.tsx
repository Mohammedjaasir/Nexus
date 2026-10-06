import { useEffect, useState } from 'react';
import type { DomainId } from '@shared/domain';
import type { Project } from '@shared/project';
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
      <div className="nxpd-layer">
        <div className="nxpd nx-float" role="dialog" aria-modal="true" aria-labelledby="nxpd-title">
          <header className="nxpd__head">
            <h2 className="nxpd__title" id="nxpd-title">Manage projects</h2>
            <button type="button" className="nx-btn nx-btn--quiet nx-btn--sm" onClick={onClose} aria-label="Close">
              Close
            </button>
          </header>

          <div className="nxpd__bar">
            <span className="nxh-label">Projects ({projects.length})</span>
            <div className="nxh-row">
              {onNewProject && (
                <button type="button" className="nx-btn nx-btn--sm" onClick={onNewProject}>New project</button>
              )}
              <button type="button" className="nx-btn nx-btn--sm" onClick={() => setImportOpen(true)}>Import a folder</button>
            </div>
          </div>

          <div className="nxpd__body">
            {/* Project selector strip */}
            {projects.length > 1 && (
              <div className="nxpd__picker" role="group" aria-label="Project">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="nx-btn nx-btn--sm"
                    aria-pressed={currentProject?.id === p.id}
                    onClick={() => handleSelectProject(p)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}

            {/* Main project summary */}
            {currentProject ? (
              <ProjectSummaryCard
                project={currentProject}
                onOpenProject={onOpenProject ?? onClose}
                onRefreshProject={handleRefreshActive}
                onChangeDomain={handleChangeDomain}
                isRefreshing={refreshing}
              />
            ) : (
              <div className="nx-empty" role="status">
                <h3 className="nx-empty__title">No projects yet</h3>
                <p className="nx-empty__body" style={{ margin: 0 }}>
                  Import a folder you already work in. Agents use it as their working directory.
                </p>
                <div className="nx-empty__actions">
                  <button type="button" className="nx-btn nx-btn--primary" onClick={() => setImportOpen(true)}>
                    Import a folder
                  </button>
                </div>
              </div>
            )}
          </div>
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
