import { useState, useEffect } from 'react';
import type { ProjectGap, ProjectGapAnalysisResult, GapStatus } from '@shared/gap';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';

export interface ProjectGapsCardProps {
  projectId: string;
  onPlanUpdated?: () => void;
}

export function ProjectGapsCard({ projectId, onPlanUpdated }: ProjectGapsCardProps) {
  const [analysis, setAnalysis] = useState<ProjectGapAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<GapStatus | 'all'>('all');
  const [expandedGapId, setExpandedGapId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);

  const loadGaps = async () => {
    if (!window.cth?.projectGapsAnalyze) return;
    setLoading(true);
    try {
      const res = await window.cth.projectGapsAnalyze(projectId);
      setAnalysis(res);
    } catch (err) {
      console.error('Failed to analyze project gaps:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleReconcile = async () => {
    if (!window.cth?.projectGapsReconcile) return;
    setReconciling(true);
    try {
      const res = await window.cth.projectGapsReconcile(projectId);
      if (res) {
        setAnalysis(res.gaps);
        onPlanUpdated?.();
      }
    } catch (err) {
      console.error('Failed to reconcile plan with gaps:', err);
    } finally {
      setReconciling(false);
    }
  };

  useEffect(() => {
    loadGaps();
  }, [projectId]);

  if (loading && !analysis) {
    return (
      <PixelPanel variant="default" style={{ padding: 14 }}>
        <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>
          Analyzing project capabilities and state-aware gaps...
        </div>
      </PixelPanel>
    );
  }

  if (!analysis) return null;

  const filteredGaps = filter === 'all'
    ? analysis.gaps
    : analysis.gaps.filter((g) => g.status === filter);

  return (
    <PixelPanel variant="default" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header & Completion Confidence */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 13, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-900)' }}>
            PROJECT GAPS & STATE-AWARE ANALYSIS (PHASE 8B)
          </div>
          <div style={{ fontSize: 11, fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)' }}>
            Evidence-Based Capabilities & Completion Confidence
          </div>
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <PixelButton variant="secondary" size="sm" onClick={loadGaps}>
            Refresh Gaps
          </PixelButton>
          <PixelButton
            variant="primary"
            size="sm"
            onClick={handleReconcile}
            disabled={reconciling}
          >
            {reconciling ? 'Reconciling…' : 'Reconcile Plan ⟳'}
          </PixelButton>
        </div>
      </div>

      {/* Completion Confidence Card */}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--cth-mint)' }}>
              {analysis.completionConfidence}%
            </span>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--cth-ink-900)' }}>
              Project Completion Confidence
            </span>
          </div>
          <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
            (Evidence-based heuristic, not guaranteed completion)
          </span>
        </div>

        {/* Confidence Breakdown Indicators */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, fontSize: 9 }}>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center' }}>
            Impl: +{analysis.confidenceBreakdown.implementationEvidenceScore}%
          </div>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center' }}>
            Tests: +{analysis.confidenceBreakdown.testEvidenceScore}%
          </div>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center' }}>
            Docs: +{analysis.confidenceBreakdown.documentationEvidenceScore}%
          </div>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center', color: analysis.confidenceBreakdown.criticalGapsPenalty > 0 ? '#E53E3E' : 'inherit' }}>
            Critical: -{analysis.confidenceBreakdown.criticalGapsPenalty}%
          </div>
          <div style={{ background: '#fff', padding: '4px 6px', textAlign: 'center', color: analysis.confidenceBreakdown.blockedPenalty > 0 ? '#E53E3E' : 'inherit' }}>
            Blocked: -{analysis.confidenceBreakdown.blockedPenalty}%
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--cth-ink-200)', paddingBottom: 4 }}>
        {[
          { key: 'all', label: `All (${analysis.gaps.length})` },
          { key: 'completed', label: `✓ Completed (${analysis.summary.completedCount})` },
          { key: 'in_progress', label: `● In Progress (${analysis.summary.inProgressCount})` },
          { key: 'missing', label: `○ Missing (${analysis.summary.missingCount})` },
          { key: 'blocked', label: `⚠ Blocked (${analysis.summary.blockedCount})` }
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key as any)}
            style={{
              padding: '3px 8px',
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 10,
              border: 'none',
              background: filter === tab.key ? 'var(--cth-mint)' : 'transparent',
              color: filter === tab.key ? 'var(--cth-ink-900)' : 'var(--cth-ink-600)',
              cursor: 'pointer',
              fontWeight: filter === tab.key ? 600 : 400
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Gaps List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filteredGaps.map((gap) => {
          const isExpanded = expandedGapId === gap.gapId;
          const isDone = gap.status === 'completed';
          const isMissing = gap.status === 'missing';
          const isBlocked = gap.status === 'blocked';

          return (
            <div
              key={gap.gapId}
              style={{
                background: isDone ? 'rgba(76, 175, 80, 0.05)' : isMissing && gap.isCritical ? '#FFF8E7' : 'var(--cth-cream-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)',
                padding: '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: 'monospace',
                      fontWeight: 700,
                      color: isDone ? 'var(--cth-mint)' : isBlocked ? '#E53E3E' : isMissing ? 'var(--cth-ink-400)' : 'var(--cth-lemon)'
                    }}
                  >
                    {isDone ? '[✓]' : gap.status === 'in_progress' ? '[●]' : isBlocked ? '[!]' : '[○]'}
                  </span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                    {gap.title}
                  </span>
                  <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--cth-ink-500)' }}>
                    ({gap.category})
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      fontSize: 9,
                      fontFamily: 'var(--cth-font-display)',
                      padding: '2px 5px',
                      background: isDone ? 'var(--cth-mint)' : isBlocked ? '#FFCDD2' : 'var(--cth-ink-200)',
                      color: 'var(--cth-ink-900)'
                    }}
                  >
                    {gap.status.toUpperCase()}
                  </span>

                  <button
                    onClick={() => setExpandedGapId(isExpanded ? null : gap.gapId)}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      fontSize: 10,
                      color: 'var(--cth-ink-600)'
                    }}
                  >
                    {isExpanded ? 'Hide Evidence ▴' : 'View Evidence ▾'}
                  </button>
                </div>
              </div>

              <div style={{ fontSize: 10, color: 'var(--cth-ink-600)', paddingLeft: 22 }}>
                {gap.description}
              </div>

              {/* Expanded Evidence Details */}
              {isExpanded && (
                <div style={{ marginTop: 4, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, color: 'var(--cth-ink-800)' }}>
                  <div style={{ fontWeight: 600 }}>Evidence Signals ({Math.round(gap.confidence * 100)}% Confidence):</div>
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {gap.evidence.map((ev, idx) => (
                      <li key={idx}>{ev}</li>
                    ))}
                  </ul>
                  {gap.suggestedTaskId && (
                    <div style={{ fontSize: 9, color: 'var(--cth-ink-500)', marginTop: 2 }}>
                      Linked Plan Task: <code>{gap.suggestedTaskId}</code>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </PixelPanel>
  );
}
