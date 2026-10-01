import { useState, useEffect } from 'react';
import type { ProjectPlan, ProjectMilestone, ProjectTask, TaskStatus } from '@shared/plan';
import type { ContextPackage } from '@shared/context';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';
import { ContextPreviewModal } from './ContextPreviewModal';

export interface ProjectPlanCardProps {
  projectId: string;
  onLaunchAgent?: (enrichedPrompt: string) => void;
}

export function ProjectPlanCard({ projectId, onLaunchAgent }: ProjectPlanCardProps) {
  const [plan, setPlan] = useState<ProjectPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTask, setSelectedTask] = useState<ProjectTask | null>(null);
  const [contextPackageForTask, setContextPackageForTask] = useState<ContextPackage | null>(null);

  const loadPlan = async () => {
    if (!window.cth?.projectPlanGet) return;
    setLoading(true);
    try {
      const p = await window.cth.projectPlanGet(projectId);
      setPlan(p);
    } catch (err) {
      console.error('Failed to load project plan:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlan();
  }, [projectId]);

  const handleRunTask = async (task: ProjectTask) => {
    if (!window.cth?.projectContextPrepare) return;
    try {
      const pkg = await window.cth.projectContextPrepare(projectId, task.title, {
        budgetTokens: 32000,
        agentRole: task.suggestedRoleId
      });
      if (pkg?.contextPackage) {
        setSelectedTask(task);
        setContextPackageForTask(pkg.contextPackage);
      }
    } catch (err) {
      console.error('Failed to prepare context for task:', err);
    }
  };

  if (loading && !plan) {
    return (
      <PixelPanel variant="default" style={{ padding: 16 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>
          Loading structured project plan...
        </div>
      </PixelPanel>
    );
  }

  if (!plan) return null;

  const { progress } = plan;

  return (
    <PixelPanel variant="default" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header & Progress */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-900)' }}>
            PROJECT PLAN & TASK GRAPH (PHASE 8A)
          </div>
          <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>
            Evidence-Based Milestones and Dependency Graph
          </div>
        </div>

        <PixelButton variant="secondary" size="sm" onClick={loadPlan}>
          Refresh Plan
        </PixelButton>
      </div>

      {/* Progress Dashboard */}
      <div
        style={{
          background: 'var(--cth-cream-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
            PROJECT PROGRESS: {progress.progressPercentage}%
          </span>
          <span style={{ fontSize: 10, color: 'var(--cth-ink-600)' }}>
            {progress.completedTasks} of {progress.totalTasks} tasks completed • {progress.completedMilestones} of {progress.totalMilestones} milestones
          </span>
        </div>

        {/* Progress Bar */}
        <div style={{ height: 8, background: 'var(--cth-ink-200)', borderRadius: 2, overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: `${progress.progressPercentage}%`,
              background: 'var(--cth-mint)',
              transition: 'width 0.3s ease'
            }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, fontSize: 10, marginTop: 4 }}>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center' }}>
            <strong>{progress.readyTasks}</strong> Ready
          </div>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center' }}>
            <strong>{progress.completedTasks}</strong> Completed
          </div>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center' }}>
            <strong>{progress.blockedTasks}</strong> Blocked
          </div>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center' }}>
            <strong>{progress.failedTasks}</strong> Failed
          </div>
        </div>
      </div>

      {/* Milestones and Tasks Tree */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {plan.milestones.map((m) => {
          const milestoneTasks = plan.tasks.filter((t) => m.taskIds.includes(t.taskId));
          const isCompleted = m.status === 'completed';

          return (
            <div
              key={m.milestoneId}
              style={{
                background: isCompleted ? 'rgba(76, 175, 80, 0.05)' : 'var(--cth-cream-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8
              }}
            >
              {/* Milestone Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: 'monospace',
                      fontWeight: 700,
                      color: isCompleted ? 'var(--cth-mint)' : 'var(--cth-ink-700)'
                    }}
                  >
                    {isCompleted ? '[✓]' : m.status === 'in_progress' ? '[●]' : m.status === 'blocked' ? '[!]' : '[○]'}
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                    {m.order}. {m.title}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: 9,
                    fontFamily: 'var(--cth-font-display)',
                    padding: '2px 6px',
                    background: isCompleted ? 'var(--cth-mint)' : 'var(--cth-ink-200)',
                    color: 'var(--cth-ink-900)'
                  }}
                >
                  {m.status.toUpperCase()}
                </span>
              </div>

              <div style={{ fontSize: 10, color: 'var(--cth-ink-600)', paddingLeft: 22 }}>
                {m.description}
              </div>

              {/* Nested Tasks */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 22, marginTop: 4 }}>
                {milestoneTasks.map((t) => {
                  const taskDone = t.status === 'completed';
                  const taskReady = t.status === 'ready';

                  return (
                    <div
                      key={t.taskId}
                      style={{
                        padding: '6px 10px',
                        background: taskDone ? 'rgba(76, 175, 80, 0.08)' : '#fff',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 11
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                        <span style={{ color: taskDone ? 'var(--cth-mint)' : taskReady ? 'var(--cth-lemon)' : 'var(--cth-ink-400)', fontWeight: 'bold' }}>
                          {taskDone ? '✓' : taskReady ? '●' : '○'}
                        </span>
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                            {t.title}
                          </div>
                          <div style={{ fontSize: 9, color: 'var(--cth-ink-500)', display: 'flex', gap: 6, marginTop: 2 }}>
                            <span>Role: <strong>{t.suggestedRoleId}</strong></span>
                            <span>• Priority: {t.priority.toUpperCase()}</span>
                            {t.dependencies.length > 0 && (
                              <span>• Depends on {t.dependencies.length} task(s)</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 6 }}>
                        <PixelButton
                          variant={taskReady ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={() => handleRunTask(t)}
                        >
                          {taskDone ? 'Re-run' : 'Run Task →'}
                        </PixelButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Context & Execution Modal */}
      {selectedTask && contextPackageForTask && (
        <ContextPreviewModal
          contextPackage={contextPackageForTask}
          onClose={() => {
            setSelectedTask(null);
            setContextPackageForTask(null);
            loadPlan();
          }}
          onLaunchAgent={onLaunchAgent}
        />
      )}
    </PixelPanel>
  );
}
