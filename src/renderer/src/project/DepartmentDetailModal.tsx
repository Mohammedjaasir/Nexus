import { useEffect, useState } from 'react';
import type { DomainId, DomainDefinition } from '@shared/domain';
import { getDomainDefinition } from '@shared/domain';
import type { Project } from '@shared/project';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { useStore } from '../store/store';

export interface DepartmentDetailModalProps {
  domainId: DomainId | null;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onNewProject: (domainId: DomainId) => void;
  onImportProject: (domainId?: DomainId) => void;
}

export function DepartmentDetailModal({
  domainId,
  onClose,
  onOpenProject,
  onNewProject,
  onImportProject
}: DepartmentDetailModalProps) {
  const projects = useStore((s) => s.projects);
  const [plans, setPlans] = useState<Record<string, any>>({});

  useEffect(() => {
    if (!domainId) return;
    const domainProjects = projects.filter((p) => p.domainId === domainId);
    domainProjects.forEach((p) => {
      window.cth.projectPlanGet(p.id).then((plan) => {
        if (plan) {
          setPlans((prev) => ({ ...prev, [p.id]: plan }));
        }
      });
    });
  }, [domainId, projects]);

  if (!domainId) return null;

  const domain: DomainDefinition = getDomainDefinition(domainId);
  const domainProjects = projects.filter((p) => p.domainId === domainId);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(23, 20, 16, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 320,
        padding: 24
      }}
    >
      <div style={{ width: 860, maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <PixelPanel
          variant="dialog"
          noPadding
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
            borderTop: `6px solid ${domain.badgeColor}`
          }}
        >
          {/* Header Banner */}
          <div
            style={{
              padding: '16px 20px',
              background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)',
              borderBottom: '2px solid var(--cth-ink-300)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 32 }}>{domain.icon}</span>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: 16,
                      fontFamily: 'var(--cth-font-display)',
                      color: 'var(--cth-ink-900)'
                    }}
                  >
                    {domain.departmentName.toUpperCase()}
                  </h2>
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: 'monospace',
                      padding: '2px 6px',
                      background: domain.badgeColor,
                      color: '#fff',
                      borderRadius: 2,
                      fontWeight: 700
                    }}
                  >
                    {domain.departmentRoom}
                  </span>
                </div>
                <p style={{ margin: '4px 0 0 0', fontSize: 11, color: 'var(--cth-ink-600)' }}>
                  {domain.description}
                </p>
              </div>
            </div>

            <PixelButton variant="secondary" size="sm" onClick={onClose}>
              ✕ Close
            </PixelButton>
          </div>

          {/* Body Content */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 20
            }}
          >
            {/* 1. Department Specialist Agents Roster */}
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--cth-font-display)',
                  color: 'var(--cth-ink-500)',
                  marginBottom: 10
                }}
              >
                DEPARTMENT SPECIALIST AGENTS ({domain.agentRoles.length})
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
                  gap: 10
                }}
              >
                {domain.agentRoles.map((role) => (
                  <div
                    key={role.roleId}
                    style={{
                      padding: 12,
                      background: '#fff',
                      border: '1px solid var(--cth-ink-200)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                          {role.title}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--cth-ink-500)', marginTop: 2 }}>
                          Avatar: <span style={{ fontWeight: 700, color: 'var(--cth-ink-800)' }}>@{role.character}</span>
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: 'monospace',
                          padding: '1px 5px',
                          background: 'var(--cth-cream-200)',
                          border: '1px solid var(--cth-ink-300)'
                        }}
                      >
                        {role.preferredProvider}
                      </span>
                    </div>

                    <p style={{ margin: 0, fontSize: 10, color: 'var(--cth-ink-600)', lineHeight: '14px' }}>
                      {role.description}
                    </p>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 'auto' }}>
                      {role.capabilities.slice(0, 3).map((cap) => (
                        <span
                          key={cap}
                          style={{
                            fontSize: 8,
                            padding: '1px 4px',
                            background: 'var(--cth-ink-100)',
                            color: 'var(--cth-ink-700)',
                            borderRadius: 2
                          }}
                        >
                          {cap}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. Department Missions (Projects) */}
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 10
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--cth-font-display)',
                    color: 'var(--cth-ink-500)'
                  }}
                >
                  ACTIVE MISSIONS ({domainProjects.length})
                </span>

                <div style={{ display: 'flex', gap: 8 }}>
                  <PixelButton variant="secondary" size="sm" onClick={() => onImportProject(domainId)}>
                    Import Project
                  </PixelButton>
                  <PixelButton variant="primary" size="sm" onClick={() => onNewProject(domainId)}>
                    + New Mission
                  </PixelButton>
                </div>
              </div>

              {domainProjects.length === 0 ? (
                <div
                  style={{
                    padding: 20,
                    background: '#fff',
                    border: '1px dashed var(--cth-ink-300)',
                    textAlign: 'center'
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-700)' }}>
                    No active missions in this department yet
                  </div>
                  <p style={{ margin: '4px 0 12px 0', fontSize: 10, color: 'var(--cth-ink-500)' }}>
                    Create or import a project to assign specialist agents to this department.
                  </p>
                  <PixelButton variant="primary" size="sm" onClick={() => onNewProject(domainId)}>
                    Start First Mission →
                  </PixelButton>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {domainProjects.map((proj, idx) => {
                    const plan = plans[proj.id];
                    const completedTasks = plan?.tasks?.filter((t: any) => t.status === 'completed')?.length ?? 0;
                    const totalTasks = plan?.tasks?.length ?? 1;
                    const progressPct = Math.round((completedTasks / totalTasks) * 100);

                    return (
                      <div
                        key={proj.id}
                        style={{
                          padding: 14,
                          background: '#fff',
                          border: '2px solid var(--cth-ink-200)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 16
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span
                              style={{
                                fontSize: 10,
                                fontFamily: 'monospace',
                                fontWeight: 700,
                                color: 'var(--cth-ink-500)'
                              }}
                            >
                              MISSION #{String(idx + 1).padStart(2, '0')}
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                              {proj.name}
                            </span>
                          </div>

                          <div style={{ fontSize: 10, color: 'var(--cth-ink-500)', marginTop: 2 }}>
                            Root: {proj.rootPath}
                          </div>

                          {/* Progress bar */}
                          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div
                              style={{
                                width: 140,
                                height: 8,
                                background: 'var(--cth-ink-100)',
                                border: '1px solid var(--cth-ink-300)',
                                overflow: 'hidden'
                              }}
                            >
                              <div
                                style={{
                                  width: `${progressPct}%`,
                                  height: '100%',
                                  background: domain.badgeColor
                                }}
                              />
                            </div>
                            <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--cth-ink-700)' }}>
                              {progressPct}% ({completedTasks}/{totalTasks} tasks)
                            </span>
                          </div>
                        </div>

                        <PixelButton variant="primary" size="md" onClick={() => onOpenProject(proj.id)}>
                          Enter Mission →
                        </PixelButton>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
