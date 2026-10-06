import { useEffect, useState } from 'react';
import type { Project } from '@shared/project';
import type { ProjectGraphStats } from '@shared/graph';
import { getDomainDefinition, type DomainId } from '@shared/domain';
import { repoHealth } from '@/nexus/data/selectors';

const HEALTH_TIP = 'Heuristic from the project analyzer: tests, docs, entry points and git status.';

export interface ProjectSummaryCardProps {
  project: Project;
  onOpenProject?: () => void;
  onRefreshProject?: () => void;
  onChangeDomain?: (newDomainId: DomainId) => void;
  onBack?: () => void;
  isRefreshing?: boolean;
}

/** One project's analyzer summary inside Manage projects. Nexus chrome
 *  (nexus/styles/hosted.css); health reads exactly as the passport does. */
export function ProjectSummaryCard({
  project,
  onOpenProject,
  onRefreshProject,
  onChangeDomain,
  onBack,
  isRefreshing = false
}: ProjectSummaryCardProps) {
  const [domainMenuOpen, setDomainMenuOpen] = useState(false);
  const [graphStats, setGraphStats] = useState<ProjectGraphStats | null>(null);
  const primaryDomainDef = getDomainDefinition(project.domainId);
  const health = repoHealth(project);

  useEffect(() => {
    let cancelled = false;
    window.cth.projectGraphGetStats(project.id).then((st) => {
      if (!cancelled) setGraphStats(st);
    });
    return () => { cancelled = true; };
  }, [project.id, project.lastAnalyzedAt, isRefreshing]);

  return (
    <article className="nxps" aria-labelledby={`nxps-${project.id}`}>
      <header className="nxps__head">
        <div style={{ minWidth: 0 }}>
          <h3 className="nxps__name" id={`nxps-${project.id}`}>{project.name}</h3>
          <div className="nxh-path">{project.rootPath}</div>
        </div>
        {health !== null && (
          <div className="nx-health" title={HEALTH_TIP}>
            <span className="nx-health__label">Repo health <strong>{health} of 100</strong></span>
            <span className="nx-health__track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={health} aria-label={`Repo health ${health} of 100`}>
              <span className="nx-health__fill" style={{ width: `${health}%` }} />
            </span>
          </div>
        )}
      </header>

      <div className="nxps__body">
        {/* Domain and selector */}
        <div className="nxh-card nxh-row" style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <div className="nxh-row">
            <span className="nxh-label">Domain</span>
            <span className="nxh-chip" data-tone="on">{primaryDomainDef.name}</span>
            {project.secondaryDomains && project.secondaryDomains.length > 0 && project.secondaryDomains.map((secId) => (
              <span key={secId} className="nxh-chip">+ {getDomainDefinition(secId).name}</span>
            ))}
          </div>

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="nx-btn nx-btn--sm"
              aria-haspopup="menu"
              aria-expanded={domainMenuOpen}
              onClick={() => setDomainMenuOpen(!domainMenuOpen)}
            >
              Change domain
            </button>

            {domainMenuOpen && (
              <div className="nx-float nxps__menu" role="menu" aria-label="Domain">
                {(['software-engineering', 'ai-ml', 'cybersecurity'] as DomainId[]).map((dId) => {
                  const dDef = getDomainDefinition(dId);
                  const isCurrent = project.domainId === dId;
                  return (
                    <button
                      key={dId}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      className={`nx-menu__item${isCurrent ? ' is-current' : ''}`}
                      onClick={() => {
                        onChangeDomain?.(dId);
                        setDomainMenuOpen(false);
                      }}
                    >
                      <span className="nx-menu__text">{dDef.name}</span>
                      {isCurrent && <span className="nx-menu__note">Current</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Recommended domain agents */}
        <section className="nxh-card" aria-labelledby={`nxps-roles-${project.id}`}>
          <h4 className="nxh-title" id={`nxps-roles-${project.id}`}>
            Recommended agents <span className="nxh-muted">({primaryDomainDef.agentRoles.length} roles)</span>
          </h4>
          <div className="nxps__roles">
            {primaryDomainDef.agentRoles.map((role) => (
              <div key={role.roleId} className="nxh-card nxh-card--sub" style={{ marginBottom: 0 }}>
                <span className="nxh-name">{role.title}</span>
                <span className="nxh-muted" title={role.description} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {role.description}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Breakdown */}
        <div className="nxps__grid">
          <section className="nxh-card">
            <h4 className="nxh-label" style={{ margin: 0 }}>Languages ({project.detectedLanguages.length})</h4>
            <div className="nxh-row" style={{ gap: 4 }}>
              {project.detectedLanguages.length > 0
                ? project.detectedLanguages.slice(0, 5).map((lang) => (
                  <span key={lang.language} className="nxh-chip">{lang.language} ({lang.fileCount})</span>
                ))
                : <span className="nxh-muted">None detected</span>}
            </div>
          </section>

          <section className="nxh-card">
            <h4 className="nxh-label" style={{ margin: 0 }}>Frameworks and dependencies ({project.dependencies.length})</h4>
            <div className="nxh-row" style={{ gap: 4 }}>
              {project.frameworks.length > 0
                ? project.frameworks.map((fw) => <span key={fw} className="nxh-chip">{fw}</span>)
                : <span className="nxh-muted">None detected</span>}
            </div>
          </section>

          <section className="nxh-card">
            <h4 className="nxh-label" style={{ margin: 0 }}>Tests and docs</h4>
            <div className="nxh-note">
              <div>Test suites: <strong>{project.testSuites.length}</strong></div>
              <div>Doc files: <strong>{project.documentationFiles.length}</strong></div>
            </div>
          </section>

          <section className="nxh-card">
            <h4 className="nxh-label" style={{ margin: 0 }}>Git repository</h4>
            <div className="nxh-note">
              {project.gitInfo?.isRepo ? (
                <>
                  <div>Branch: <span className="nx-id">{project.gitInfo.branch ?? 'HEAD'}</span></div>
                  <div>Working tree: <strong>{project.gitInfo.isClean ? 'Clean' : 'Modified'}</strong></div>
                </>
              ) : (
                <span className="nxh-muted">No git repository detected</span>
              )}
            </div>
          </section>
        </div>

        {/* Important files and entry points */}
        {(project.entryPoints.length > 0 || project.importantFiles.length > 0) && (
          <div className="nxh-card nxh-note">
            {project.entryPoints.length > 0 && (
              <div>
                <strong>Entry points:</strong> <span className="nx-id">{project.entryPoints.join(', ')}</span>
              </div>
            )}
            {project.importantFiles.length > 0 && (
              <div>
                <strong>Key configs:</strong> <span className="nx-id">{project.importantFiles.slice(0, 6).join(', ')}</span>
              </div>
            )}
          </div>
        )}

        {/* Project knowledge graph summary */}
        <section className="nxh-card">
          <h4 className="nxh-label" style={{ margin: 0 }}>Project knowledge graph</h4>
          <div className="nxh-meta" aria-busy={graphStats === null}>
            <span>Nodes {graphStats?.nodeCount ?? '…'}</span>
            <span>Edges {graphStats?.edgeCount ?? '…'}</span>
            <span>Files {graphStats?.fileCount ?? '…'}</span>
            <span>Functions {graphStats?.functionCount ?? '…'}</span>
            <span>Classes {graphStats?.classCount ?? '…'}</span>
            <span>Tests {graphStats?.testCount ?? '…'}</span>
          </div>
        </section>

        {/* Actions */}
        <div className="nxps__foot">
          <div>
            {onBack && (
              <button type="button" className="nx-btn" onClick={onBack}>Back</button>
            )}
          </div>

          <div className="nxh-row">
            <button type="button" className="nx-btn" onClick={onRefreshProject} disabled={isRefreshing}>
              {isRefreshing ? 'Analyzing…' : 'Re-analyze'}
            </button>

            {onOpenProject && (
              <button type="button" className="nx-btn nx-btn--primary" onClick={onOpenProject}>
                Open project
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
