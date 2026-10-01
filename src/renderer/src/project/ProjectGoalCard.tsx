import { useState, useEffect } from 'react';
import type { GoalAnalysisResult, GoalCapability } from '@shared/goal';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';

export interface ProjectGoalCardProps {
  projectId: string;
  onPlanUpdated?: () => void;
}

export function ProjectGoalCard({ projectId, onPlanUpdated }: ProjectGoalCardProps) {
  const [analysis, setAnalysis] = useState<GoalAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [goalInput, setGoalInput] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const loadGoal = async () => {
    if (!window.cth?.projectGoalGet) return;
    setLoading(true);
    try {
      const res = await window.cth.projectGoalGet(projectId);
      setAnalysis(res);
      if (res?.goal) {
        setGoalInput(res.goal.title);
      }
    } catch (err) {
      console.error('Failed to load project goal:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSetGoal = async () => {
    if (!goalInput.trim() || !window.cth?.projectGoalSet) return;
    setSubmitting(true);
    try {
      const res = await window.cth.projectGoalSet(projectId, goalInput.trim());
      setAnalysis(res);
      setIsEditing(false);
      onPlanUpdated?.();
    } catch (err) {
      console.error('Failed to set project goal:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReconcileGoalPlan = async () => {
    if (!window.cth?.projectGoalReconcile) return;
    setReconciling(true);
    try {
      const res = await window.cth.projectGoalReconcile(projectId);
      if (res) {
        setAnalysis(res.goalAnalysis);
        onPlanUpdated?.();
      }
    } catch (err) {
      console.error('Failed to reconcile goal plan:', err);
    } finally {
      setReconciling(false);
    }
  };

  useEffect(() => {
    loadGoal();
  }, [projectId]);

  if (loading && !analysis) {
    return (
      <PixelPanel variant="default" style={{ padding: 14 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>
          Loading goal requirements...
        </div>
      </PixelPanel>
    );
  }

  const hasGoal = !!analysis?.goal && !isEditing;

  return (
    <PixelPanel variant="default" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-900)' }}>
            PROJECT GOAL & TARGET CAPABILITIES (PHASE 8C)
          </div>
          <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>
            What is this project supposed to become?
          </div>
        </div>

        {hasGoal && (
          <div style={{ display: 'flex', gap: 6 }}>
            <PixelButton variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
              Edit Goal
            </PixelButton>
            <PixelButton
              variant="primary"
              size="sm"
              onClick={handleReconcileGoalPlan}
              disabled={reconciling}
            >
              {reconciling ? 'Reconciling…' : 'Generate / Reconcile Plan ⟳'}
            </PixelButton>
          </div>
        )}
      </div>

      {/* Goal Input Mode */}
      {(!hasGoal || isEditing) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--cth-cream-100)', padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
            Define the High-Level Project Goal:
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={goalInput}
              onChange={(e) => setGoalInput(e.target.value)}
              placeholder="e.g. Build a production OCR API with document preprocessing..."
              style={{
                flex: 1,
                padding: '6px 10px',
                fontFamily: 'var(--cth-font-ui)',
                fontSize: 12,
                border: '1px solid var(--cth-ink-300)',
                background: '#fff'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSetGoal();
              }}
            />
            <PixelButton
              variant="primary"
              size="sm"
              onClick={handleSetGoal}
              disabled={submitting || !goalInput.trim()}
            >
              {submitting ? 'Analyzing…' : 'Set Goal & Analyze'}
            </PixelButton>
            {isEditing && (
              <PixelButton variant="secondary" size="sm" onClick={() => setIsEditing(false)}>
                Cancel
              </PixelButton>
            )}
          </div>
        </div>
      )}

      {/* Active Goal View */}
      {hasGoal && analysis && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Goal Summary Card */}
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
              <div>
                <span style={{ fontSize: 10, color: 'var(--cth-ink-500)', textTransform: 'uppercase' }}>
                  Target Goal
                </span>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                  "{analysis.goal.title}"
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--cth-mint)' }}>
                  {analysis.goalReadinessScore}%
                </div>
                <div style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>
                  Goal Readiness
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--cth-ink-600)' }}>
              <span>✓ <strong>{analysis.completedCapabilitiesCount}</strong> Completed</span>
              <span>● <strong>{analysis.inProgressCapabilitiesCount}</strong> In Progress</span>
              <span>○ <strong>{analysis.missingCapabilitiesCount}</strong> Missing</span>
              {analysis.blockedCapabilitiesCount > 0 && (
                <span style={{ color: '#E53E3E' }}>⚠ <strong>{analysis.blockedCapabilitiesCount}</strong> Blocked</span>
              )}
            </div>
          </div>

          {/* Required Capabilities Breakdown */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-800)', marginTop: 4 }}>
              REQUIRED CAPABILITIES
            </div>

            {analysis.evaluatedCapabilities.map((cap) => {
              const isDone = cap.status === 'completed';
              const isMissing = cap.status === 'missing';
              const isBlocked = cap.status === 'blocked';

              return (
                <div
                  key={cap.capabilityId}
                  style={{
                    padding: '8px 10px',
                    background: isDone ? 'rgba(76, 175, 80, 0.05)' : isMissing ? '#FFF8E7' : '#fff',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          fontWeight: 'bold',
                          color: isDone ? 'var(--cth-mint)' : isBlocked ? '#E53E3E' : isMissing ? 'var(--cth-ink-400)' : 'var(--cth-lemon)'
                        }}
                      >
                        {isDone ? '✓' : cap.status === 'in_progress' ? '●' : isBlocked ? '!' : '○'}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
                        {cap.name}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--cth-ink-400)' }}>
                        ({cap.category})
                      </span>
                    </div>

                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: 'var(--cth-font-display)',
                        padding: '1px 5px',
                        background: isDone ? 'var(--cth-mint)' : 'var(--cth-ink-200)',
                        color: 'var(--cth-ink-900)'
                      }}
                    >
                      {(cap.status || 'unknown').toUpperCase()}
                    </span>
                  </div>

                  <div style={{ fontSize: 10, color: 'var(--cth-ink-600)', paddingLeft: 18 }}>
                    {cap.description}
                  </div>

                  {cap.evidence && cap.evidence.length > 0 && (
                    <div style={{ fontSize: 9, color: 'var(--cth-ink-500)', paddingLeft: 18 }}>
                      Evidence: {cap.evidence.join(' • ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PixelPanel>
  );
}
