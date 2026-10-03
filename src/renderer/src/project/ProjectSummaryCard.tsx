import { useEffect, useState } from 'react';
import type { Project } from '@shared/project';
import type { ProjectGraphStats } from '@shared/graph';
import { getDomainDefinition, type DomainId } from '@shared/domain';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { ProjectPlanCard } from './ProjectPlanCard';
import { ProjectGapsCard } from './ProjectGapsCard';
import { ProjectGoalCard } from './ProjectGoalCard';
import { ProjectCompletionPanel } from './ProjectCompletionPanel';

export interface ProjectSummaryCardProps {
  project: Project;
  onOpenProject?: () => void;
  onRefreshProject?: () => void;
  onChangeDomain?: (newDomainId: DomainId) => void;
  onBack?: () => void;
  isRefreshing?: boolean;
}

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

  useEffect(() => {
    let cancelled = false;
    window.cth.projectGraphGetStats(project.id).then((st) => {
      if (!cancelled) setGraphStats(st);
    });
    return () => { cancelled = true; };
  }, [project.id, project.lastAnalyzedAt, isRefreshing]);

  const healthColor =
    project.health.healthScore >= 80
      ? 'var(--cth-mint)'
      : project.health.healthScore >= 50
      ? 'var(--cth-lemon)'
      : 'var(--cth-coral)';

  return (
    <PixelPanel variant="default" noPadding style={{ width: '100%' }}>
      {/* Top Header */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '2px solid var(--cth-ink-100)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--cth-cream-200)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--cth-mint-light)',
              boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-900)'
            }}
          >
            <Icon name="folder" />
          </div>
          <div>
            <div
              style={{
                fontFamily: 'var(--cth-font-display)',
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--cth-ink-900)'
              }}
            >
              {project.name}
            </div>
            <div
              style={{
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 11,
                color: 'var(--cth-ink-500)',
                wordBreak: 'break-all'
              }}
            >
              {project.rootPath}
            </div>
          </div>
        </div>

        {/* Health Score Badge */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            background: 'var(--cth-cream-100)',
            boxShadow: `inset 0 0 0 1.5px ${healthColor}`
          }}
        >
          <span style={{ fontSize: 10, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>
            HEALTH:
          </span>
          <span
            style={{
              fontSize: 14,
              fontFamily: 'var(--cth-font-display)',
              fontWeight: 700,
              color: 'var(--cth-ink-900)'
            }}
          >
            {project.health.healthScore}%
          </span>
        </div>
      </div>

      {/* Main Body Grid */}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* Domain Information & Selector */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            background: 'var(--cth-cream-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 10, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>
              DOMAIN:
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '2px 8px',
                  background: 'var(--cth-sky-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-sky)',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 12,
                  fontWeight: 600
                }}
              >
                ⚡ {primaryDomainDef.name}
              </span>

              {project.secondaryDomains && project.secondaryDomains.length > 0 && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {project.secondaryDomains.map((secId) => {
                    const secDef = getDomainDefinition(secId);
                    return (
                      <span
                        key={secId}
                        style={{
                          padding: '1px 6px',
                          background: 'var(--cth-cream-200)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                          fontSize: 10,
                          color: 'var(--cth-ink-700)'
                        }}
                      >
                        + {secDef.name}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div style={{ position: 'relative' }}>
            <PixelButton
              variant="secondary"
              size="sm"
              onClick={() => setDomainMenuOpen(!domainMenuOpen)}
            >
              Change Domain ▾
            </PixelButton>

            {domainMenuOpen && (
              <div
                style={{
                  position: 'absolute',
                  right: 0,
                  top: '100%',
                  marginTop: 4,
                  width: 200,
                  background: 'var(--cth-cream-100)',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15), inset 0 0 0 1.5px var(--cth-ink-900)',
                  zIndex: 100,
                  display: 'flex',
                  flexDirection: 'column'
                }}
              >
                {(['software-engineering', 'ai-ml', 'cybersecurity'] as DomainId[]).map((dId) => {
                  const dDef = getDomainDefinition(dId);
                  const isCurrent = project.domainId === dId;
                  return (
                    <button
                      key={dId}
                      onClick={() => {
                        onChangeDomain?.(dId);
                        setDomainMenuOpen(false);
                      }}
                      style={{
                        padding: '8px 12px',
                        border: 'none',
                        borderBottom: '1px solid var(--cth-ink-100)',
                        background: isCurrent ? 'var(--cth-mint-light)' : 'transparent',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontFamily: 'var(--cth-font-ui)',
                        fontSize: 12,
                        color: 'var(--cth-ink-900)'
                      }}
                    >
                      {isCurrent ? '✓ ' : ''}{dDef.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Recommended Domain Agents */}
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--cth-cream-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 10, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>
              RECOMMENDED AGENTS ({primaryDomainDef.agentRoles.length} ROLES)
            </div>
            <div style={{ fontSize: 10, color: 'var(--cth-ink-400)', fontFamily: 'var(--cth-font-ui)' }}>
              Domain-Specialized Profile Registry
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 6 }}>
            {primaryDomainDef.agentRoles.map((role) => (
              <div
                key={role.roleId}
                style={{
                  padding: '6px 8px',
                  background: 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                    {role.title}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: 'var(--cth-ink-600)',
                    fontFamily: 'var(--cth-font-ui)',
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={role.description}
                >
                  {role.description}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Breakdown Stats Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 10
          }}
        >
          {/* Languages */}
          <div
            style={{
              padding: 10,
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontFamily: 'var(--cth-font-display)',
                color: 'var(--cth-ink-500)',
                marginBottom: 6
              }}
            >
              LANGUAGES ({project.detectedLanguages.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {project.detectedLanguages.slice(0, 5).map((lang) => (
                <span
                  key={lang.language}
                  style={{
                    padding: '2px 6px',
                    background: 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                    fontSize: 11,
                    fontFamily: 'var(--cth-font-ui)'
                  }}
                >
                  {lang.language} ({lang.fileCount})
                </span>
              ))}
            </div>
          </div>

          {/* Frameworks & Dependencies */}
          <div
            style={{
              padding: 10,
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontFamily: 'var(--cth-font-display)',
                color: 'var(--cth-ink-500)',
                marginBottom: 6
              }}
            >
              FRAMEWORKS & DEPS ({project.dependencies.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {project.frameworks.length > 0 ? (
                project.frameworks.map((fw) => (
                  <span
                    key={fw}
                    style={{
                      padding: '2px 6px',
                      background: 'var(--cth-lemon-light)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-lemon)',
                      fontSize: 11,
                      fontFamily: 'var(--cth-font-ui)'
                    }}
                  >
                    {fw}
                  </span>
                ))
              ) : (
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>None detected</span>
              )}
            </div>
          </div>

          {/* Test Suites & Documentation */}
          <div
            style={{
              padding: 10,
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontFamily: 'var(--cth-font-display)',
                color: 'var(--cth-ink-500)',
                marginBottom: 6
              }}
            >
              TESTS & DOCS
            </div>
            <div style={{ fontSize: 11, lineHeight: '18px', color: 'var(--cth-ink-700)' }}>
              <div>🧪 Test Suites: <strong>{project.testSuites.length}</strong></div>
              <div>📖 Doc Files: <strong>{project.documentationFiles.length}</strong></div>
            </div>
          </div>

          {/* Git Status */}
          <div
            style={{
              padding: 10,
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
            }}
          >
            <div
              style={{
                fontSize: 9,
                fontFamily: 'var(--cth-font-display)',
                color: 'var(--cth-ink-500)',
                marginBottom: 6
              }}
            >
              GIT REPOSITORY
            </div>
            <div style={{ fontSize: 11, lineHeight: '18px', color: 'var(--cth-ink-700)' }}>
              {project.gitInfo?.isRepo ? (
                <>
                  <div>Branch: <strong>{project.gitInfo.branch ?? 'HEAD'}</strong></div>
                  <div>Working Tree: <strong>{project.gitInfo.isClean ? 'Clean' : 'Modified'}</strong></div>
                </>
              ) : (
                <span style={{ color: 'var(--cth-ink-400)' }}>No Git repo detected</span>
              )}
            </div>
          </div>
        </div>

        {/* Important Files & Entry Points */}
        {(project.entryPoints.length > 0 || project.importantFiles.length > 0) && (
          <div
            style={{
              padding: '8px 12px',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
              fontSize: 11,
              color: 'var(--cth-ink-700)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4
            }}
          >
            {project.entryPoints.length > 0 && (
              <div>
                <strong>Entry Points:</strong> {project.entryPoints.join(', ')}
              </div>
            )}
            {project.importantFiles.length > 0 && (
              <div>
                <strong>Key Configs:</strong> {project.importantFiles.slice(0, 6).join(', ')}
              </div>
            )}
          </div>
        )}

        {/* Project Knowledge Graph Summary Strip */}
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--cth-cream-100)',
            boxShadow: 'inset 0 0 0 1.5px var(--cth-mint)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8
          }}
        >
          <div>
            <div
              style={{
                fontFamily: 'var(--cth-font-display)',
                fontSize: 10,
                color: 'var(--cth-ink-500)',
                marginBottom: 4
              }}
            >
              PROJECT KNOWLEDGE GRAPH
            </div>
            <div
              style={{
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 12,
                color: 'var(--cth-ink-900)',
                display: 'flex',
                gap: 12,
                flexWrap: 'wrap'
              }}
            >
              <span><strong>Nodes:</strong> {graphStats?.nodeCount ?? '…'}</span>
              <span>• <strong>Edges:</strong> {graphStats?.edgeCount ?? '…'}</span>
              <span>• <strong>Files:</strong> {graphStats?.fileCount ?? '…'}</span>
              <span>• <strong>Functions:</strong> {graphStats?.functionCount ?? '…'}</span>
              <span>• <strong>Classes:</strong> {graphStats?.classCount ?? '…'}</span>
              <span>• <strong>Tests:</strong> {graphStats?.testCount ?? '…'}</span>
            </div>
          </div>
          <div>
            <PixelButton
              variant="secondary"
              size="sm"
              disabled
              title="Interactive graph visualization coming in Phase 5"
            >
              View Graph ↗
            </PixelButton>
          </div>
        </div>

        {/* Controlled Project Execution (Phase 9A) */}
        <ProjectCompletionPanel projectId={project.id} />

        {/* Project Goal & Target Capabilities (Phase 8C) */}
        <ProjectGoalCard projectId={project.id} />

        {/* Project Gaps & State-Aware Analysis (Phase 8B) */}
        <ProjectGapsCard projectId={project.id} />

        {/* Project Plan & Task Graph (Phase 8A) */}
        <ProjectPlanCard projectId={project.id} />

        {/* Action Controls */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingTop: 8,
            borderTop: '1px solid var(--cth-ink-100)'
          }}
        >
          <div>
            {onBack && (
              <PixelButton variant="secondary" onClick={onBack}>
                ← Back
              </PixelButton>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <PixelButton
              variant="secondary"
              onClick={onRefreshProject}
              disabled={isRefreshing}
            >
              {isRefreshing ? 'Analyzing…' : '↻ Re-analyze'}
            </PixelButton>

            {onOpenProject && (
              <PixelButton variant="primary" onClick={onOpenProject}>
                Open Project →
              </PixelButton>
            )}
          </div>
        </div>
      </div>
    </PixelPanel>
  );
}
