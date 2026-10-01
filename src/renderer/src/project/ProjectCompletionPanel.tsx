import { useState, useEffect } from 'react';
import type { NextTaskResult, ProjectStepResult, ProjectState, ProjectCompletionContract } from '@shared/completion';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';

export interface ProjectCompletionPanelProps {
  projectId: string;
  onPlanUpdated?: () => void;
}

export function ProjectCompletionPanel({ projectId, onPlanUpdated }: ProjectCompletionPanelProps) {
  const [nextTaskInfo, setNextTaskInfo] = useState<NextTaskResult | null>(null);
  const [lastStepResult, setLastStepResult] = useState<ProjectStepResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const loadNextTask = async () => {
    if (!window.cth?.projectCompleteNext) return;
    setLoading(true);
    try {
      const res = await window.cth.projectCompleteNext(projectId);
      setNextTaskInfo(res);
    } catch (err) {
      console.error('Failed to load next project task:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteStep = async () => {
    if (!window.cth?.projectCompleteStep) return;
    setRunning(true);
    try {
      const res = await window.cth.projectCompleteStep(projectId);
      setLastStepResult(res);
      await loadNextTask();
      onPlanUpdated?.();
    } catch (err) {
      console.error('Failed to execute project step:', err);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    loadNextTask();
  }, [projectId]);

  if (loading && !nextTaskInfo) {
    return (
      <PixelPanel variant="default" style={{ padding: 14 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>
          Evaluating next ready task and completion contract...
        </div>
      </PixelPanel>
    );
  }

  if (!nextTaskInfo) return null;

  const { contract, task, executionPlan, projectState } = nextTaskInfo;

  return (
    <PixelPanel
      variant="default"
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        background: contract.isGoalComplete ? 'rgba(76, 175, 80, 0.04)' : 'var(--cth-cream-100)',
        border: '1px solid var(--cth-ink-300)'
      }}
    >
      {/* Header & Status Banner */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-900)' }}>
              CONTROLLED PROJECT EXECUTION (PHASE 9A)
            </span>
            <span
              style={{
                fontSize: 9,
                fontFamily: 'monospace',
                padding: '2px 6px',
                background: contract.isGoalComplete ? 'var(--cth-mint)' : projectState === 'blocked' ? '#FFCDD2' : 'var(--cth-ink-200)',
                color: 'var(--cth-ink-900)',
                fontWeight: 700
              }}
            >
              STATE: {projectState.toUpperCase()}
            </span>
          </div>
          <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)', marginTop: 2 }}>
            Progressive One-Task-At-A-Time Verified Pipeline
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <PixelButton variant="secondary" size="sm" onClick={loadNextTask}>
            Refresh Status
          </PixelButton>
          {task && (
            <PixelButton
              variant="primary"
              size="sm"
              onClick={handleExecuteStep}
              disabled={running}
            >
              {running ? 'Executing & Verifying…' : 'Run Next Task →'}
            </PixelButton>
          )}
        </div>
      </div>

      {/* Goal Complete Banner */}
      {contract.isGoalComplete && (
        <div
          style={{
            background: 'rgba(76, 175, 80, 0.15)',
            border: '1px solid var(--cth-mint)',
            padding: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}
        >
          <span style={{ fontSize: 24 }}>🎉</span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
              PROJECT GOAL VERIFIED COMPLETE
            </div>
            <div style={{ fontSize: 10, color: 'var(--cth-ink-700)', marginTop: 2 }}>
              All required capabilities verified, test assertions pass, zero critical gaps remain.
            </div>
          </div>
        </div>
      )}

      {/* Last Step Result Banner */}
      {lastStepResult && (
        <div
          style={{
            background: lastStepResult.executionResult.verification.status === 'success' ? 'rgba(76, 175, 80, 0.08)' : '#FFF0F0',
            border: `1px solid ${lastStepResult.executionResult.verification.status === 'success' ? 'var(--cth-mint)' : '#E53E3E'}`,
            padding: 10,
            fontSize: 11
          }}
        >
          <div style={{ fontWeight: 700, color: 'var(--cth-ink-900)' }}>
            {lastStepResult.executionResult.verification.status === 'success' ? '✓ TASK VERIFIED' : '⚠ TASK VERIFICATION FAILED'}
          </div>
          <div style={{ fontSize: 10, color: 'var(--cth-ink-700)', marginTop: 2 }}>
            Task: "{lastStepResult.taskTitle}" (Attempt {lastStepResult.repairAttempts} of 2)
          </div>
          <div style={{ fontSize: 9, color: 'var(--cth-ink-500)', marginTop: 2 }}>
            Output: {lastStepResult.executionResult.verification.summary || 'Verification complete.'}
          </div>
        </div>
      )}

      {/* Active Ready Task & Approval Card */}
      {task && executionPlan && !contract.isGoalComplete && (
        <div
          style={{
            background: '#fff',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--cth-lemon)', textTransform: 'uppercase' }}>
              ● CURRENT READY TASK
            </span>
            <span style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>
              Priority: {task.priority.toUpperCase()}
            </span>
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
            {task.title}
          </div>
          <div style={{ fontSize: 11, color: 'var(--cth-ink-600)' }}>
            {task.description}
          </div>

          {/* Configuration Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 10, background: 'var(--cth-cream-100)', padding: 8 }}>
            <div>
              <span style={{ color: 'var(--cth-ink-500)' }}>ROLE:</span>
              <div style={{ fontWeight: 600 }}>{executionPlan.role.title} (@{executionPlan.role.character})</div>
            </div>
            <div>
              <span style={{ color: 'var(--cth-ink-500)' }}>MODEL:</span>
              <div style={{ fontWeight: 600 }}>{executionPlan.selectedProvider} ({executionPlan.selectedModel || executionPlan.role.preferredModel || 'default'})</div>
            </div>
            <div>
              <span style={{ color: 'var(--cth-ink-500)' }}>CONTEXT:</span>
              <div style={{ fontWeight: 600 }}>{executionPlan.contextPackage.selectedFiles.length} files (~{executionPlan.contextPackage.estimatedTokens} tokens)</div>
            </div>
            <div>
              <span style={{ color: 'var(--cth-ink-500)' }}>VERIFY RULES:</span>
              <div style={{ fontWeight: 600 }}>{executionPlan.verificationRuleIds.length} rule(s)</div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <PixelButton
              variant="primary"
              size="sm"
              onClick={handleExecuteStep}
              disabled={running}
            >
              {running ? 'Executing Step…' : 'Approve & Run Task →'}
            </PixelButton>
          </div>
        </div>
      )}

      {/* Completion Contract Reasons Breakdown */}
      <div style={{ fontSize: 10, color: 'var(--cth-ink-600)', background: '#fff', padding: 8 }}>
        <span style={{ fontWeight: 600, color: 'var(--cth-ink-800)' }}>Verification Contract Audit:</span>
        <ul style={{ margin: '4px 0 0 0', paddingLeft: 16 }}>
          {contract.reasons.map((r, idx) => (
            <li key={idx}>{r}</li>
          ))}
        </ul>
      </div>
    </PixelPanel>
  );
}
