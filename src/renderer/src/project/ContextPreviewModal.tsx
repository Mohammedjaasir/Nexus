import { useState, useEffect } from 'react';
import type { ContextPackage } from '@shared/context';
import type { TaskRoutingResult, AgentRoleCandidate } from '@shared/routing';
import type { DomainAgentRole } from '@shared/domain';
import type { TaskExecutionPlan, TaskExecutionResult, TaskVerificationSummary } from '@shared/execution';
import type { AgentProvider } from '@shared/agentProvider';
import { PixelPanel } from '../components/PixelPanel';
import { PixelButton } from '../components/PixelButton';
import { Icon } from '../components/Icon';

export interface ContextPreviewModalProps {
  contextPackage: ContextPackage;
  onClose: () => void;
  onLaunchAgent?: (enrichedPrompt: string, selectedRole?: DomainAgentRole) => void;
}

export function ContextPreviewModal({
  contextPackage,
  onClose,
  onLaunchAgent
}: ContextPreviewModalProps) {
  const [activeTab, setActiveTab] = useState<'routing' | 'files' | 'verify' | 'raw'>('routing');
  const [routingResult, setRoutingResult] = useState<TaskRoutingResult | null>(null);
  const [selectedRole, setSelectedRole] = useState<DomainAgentRole | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>('claude');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [showRolePicker, setShowRolePicker] = useState(false);
  const [availableRoles, setAvailableRoles] = useState<DomainAgentRole[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<TaskExecutionResult | null>(null);

  useEffect(() => {
    let active = true;
    if (window.cth?.projectTaskRoute) {
      window.cth.projectTaskRoute(contextPackage.projectId, contextPackage.task).then((res) => {
        if (active && res) {
          setRoutingResult(res);
          setSelectedRole(res.recommendedRole);
          setSelectedProvider(res.recommendedRole.preferredProvider || 'claude');
          setSelectedModel(res.recommendedRole.preferredModel || '');
        }
      });
    }
    if (window.cth?.projectRolesList) {
      window.cth.projectRolesList(contextPackage.projectId).then((roles) => {
        if (active && roles) {
          setAvailableRoles(roles);
        }
      });
    }
    return () => {
      active = false;
    };
  }, [contextPackage.projectId, contextPackage.task]);

  const currentRole = selectedRole || routingResult?.recommendedRole;

  const handleStartAgent = async () => {
    if (!currentRole) return;
    setIsExecuting(true);

    try {
      if (window.cth?.projectTaskPlan && window.cth?.projectTaskExecute) {
        const plan = await window.cth.projectTaskPlan(contextPackage.projectId, contextPackage.task, {
          roleId: currentRole.roleId,
          provider: selectedProvider,
          model: selectedModel || undefined,
          budgetTokens: currentRole.contextStrategy.defaultBudgetTokens
        });

        if (plan) {
          const result = await window.cth.projectTaskExecute(plan);
          if (result) {
            setExecutionResult(result);
            setIsExecuting(false);
            return;
          }
        }
      }

      // Fallback to onLaunchAgent if available
      onLaunchAgent?.(contextPackage.assembledText, currentRole);
    } catch (err) {
      console.error('Task execution error:', err);
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 20
      }}
      onClick={onClose}
    >
      <div
        style={{ width: '100%', maxWidth: 840, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <PixelPanel variant="default" noPadding style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
          {/* Header */}
          <div
            style={{
              padding: '12px 16px',
              borderBottom: '2px solid var(--cth-ink-900)',
              background: 'var(--cth-cream-200)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}
          >
            <div>
              <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                TASK EXECUTION & VERIFICATION (PHASE 7C)
              </div>
              <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                Task → Role → Context → Model → Agent → Verification
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: 16,
                color: 'var(--cth-ink-700)'
              }}
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: 16, overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Task Card */}
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--cth-cream-100)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)'
              }}
            >
              <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-500)', marginBottom: 4 }}>
                TASK SPECIFICATION
              </div>
              <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', fontWeight: 600 }}>
                "{contextPackage.task}"
              </div>
            </div>

            {/* Execution Result Banner (When execution completes) */}
            {executionResult && (
              <div
                style={{
                  padding: 12,
                  background:
                    executionResult.verification.status === 'success'
                      ? 'var(--cth-mint-light)'
                      : executionResult.verification.status === 'failed'
                      ? '#FFEEEE'
                      : '#FFF8E7',
                  border: `2px solid ${
                    executionResult.verification.status === 'success'
                      ? 'var(--cth-mint)'
                      : executionResult.verification.status === 'failed'
                      ? '#E53E3E'
                      : 'var(--cth-lemon)'
                  }`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 12, fontWeight: 700 }}>
                    TASK RESULT: {executionResult.verification.status.toUpperCase()}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--cth-ink-600)' }}>
                    Latency: {executionResult.executionLatencyMs} ms
                  </div>
                </div>

                <div style={{ fontSize: 11, color: 'var(--cth-ink-800)' }}>
                  {executionResult.verification.summary}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, fontSize: 10, marginTop: 4 }}>
                  <div style={{ background: 'rgba(255,255,255,0.7)', padding: '4px 6px' }}>
                    <strong>Agent:</strong> {executionResult.role.title}
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.7)', padding: '4px 6px' }}>
                    <strong>Model:</strong> {executionResult.provider}
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.7)', padding: '4px 6px' }}>
                    <strong>Context Tokens:</strong> {executionResult.contextTokens.toLocaleString()}
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.7)', padding: '4px 6px' }}>
                    <strong>Tests:</strong> {executionResult.verification.testsPassed}/{executionResult.verification.testsExecuted} ok
                  </div>
                </div>
              </div>
            )}

            {/* Recommended Agent Card */}
            {currentRole && (
              <div
                style={{
                  padding: '12px',
                  background: 'var(--cth-mint-light)',
                  boxShadow: 'inset 0 0 0 1.5px var(--cth-mint-dark)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 9, fontFamily: 'var(--cth-font-display)', background: 'var(--cth-mint)', padding: '2px 6px', color: 'var(--cth-ink-900)' }}>
                      RECOMMENDED AGENT
                    </span>
                    <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 13, fontWeight: 700, color: 'var(--cth-ink-900)' }}>
                      {currentRole.title}
                    </span>
                    <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--cth-ink-600)' }}>
                      @{currentRole.character}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 6 }}>
                    <PixelButton
                      variant="secondary"
                      size="sm"
                      onClick={() => setShowRolePicker(!showRolePicker)}
                    >
                      {showRolePicker ? 'Hide Options' : 'Choose Another Role ▾'}
                    </PixelButton>
                  </div>
                </div>

                <div style={{ fontSize: 11, color: 'var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)' }}>
                  {currentRole.description}
                </div>

                {/* Model & Provider Customization Controls */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 8px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--cth-ink-700)' }}>MODEL PROVIDER:</div>
                  <select
                    value={selectedProvider}
                    onChange={(e) => setSelectedProvider(e.target.value as AgentProvider)}
                    style={{
                      padding: '2px 6px',
                      fontFamily: 'var(--cth-font-ui)',
                      fontSize: 11,
                      border: '1px solid var(--cth-ink-300)',
                      background: '#fff'
                    }}
                  >
                    <option value="claude">Claude Code (Recommended)</option>
                    <option value="ollama">Ollama (Local / Open-Source)</option>
                    <option value="opencode">OpenCode Interpreter</option>
                    <option value="codex">Codex Remote</option>
                    <option value="gemini">Gemini Cloud Provider</option>
                  </select>

                  <div style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
                    Budget: {currentRole.contextStrategy.defaultBudgetTokens.toLocaleString()} tokens
                  </div>
                </div>

                {/* Why Recommended Reasons */}
                {routingResult?.reasons && routingResult.reasons.length > 0 && (
                  <div style={{ background: 'rgba(255,255,255,0.7)', padding: '6px 8px', borderRadius: 2, fontSize: 10, color: 'var(--cth-ink-800)' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: 2 }}>Why Recommended:</div>
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {routingResult.reasons.map((r, idx) => (
                        <li key={idx}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Alternative Role Picker Drawer */}
                {showRolePicker && (
                  <div style={{ marginTop: 6, padding: 8, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-200)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ fontSize: 10, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-600)' }}>
                      AVAILABLE DOMAIN ROLES ({availableRoles.length})
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 4, maxHeight: 140, overflowY: 'auto' }}>
                      {availableRoles.map((r) => (
                        <button
                          key={r.roleId}
                          onClick={() => {
                            setSelectedRole(r);
                            setSelectedProvider(r.preferredProvider || 'claude');
                            setSelectedModel(r.preferredModel || '');
                            setShowRolePicker(false);
                          }}
                          style={{
                            padding: '4px 6px',
                            textAlign: 'left',
                            background: currentRole.roleId === r.roleId ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
                            border: '1px solid var(--cth-ink-200)',
                            cursor: 'pointer',
                            fontSize: 10,
                            fontFamily: 'var(--cth-font-ui)'
                          }}
                        >
                          <strong>{r.title}</strong> (@{r.character})
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Metrics Dashboard */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 8
              }}
            >
              <div style={{ padding: '8px 10px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>OPTIMIZED CONTEXT</div>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: 'var(--cth-mint)' }}>
                  {contextPackage.estimatedTokens.toLocaleString()}
                </div>
                <div style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>estimated tokens</div>
              </div>

              <div style={{ padding: '8px 10px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>BASELINE CONTEXT</div>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: 'var(--cth-ink-700)' }}>
                  {contextPackage.baselineTokens.toLocaleString()}
                </div>
                <div style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>estimated tokens</div>
              </div>

              <div style={{ padding: '8px 10px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>TOKEN REDUCTION</div>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: 'var(--cth-mint)' }}>
                  {contextPackage.reductionPercentage}%
                </div>
                <div style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>vs full baseline</div>
              </div>

              <div style={{ padding: '8px 10px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                <div style={{ fontSize: 9, fontFamily: 'var(--cth-font-display)', color: 'var(--cth-ink-500)' }}>BUDGET LIMIT</div>
                <div style={{ fontSize: 15, fontWeight: 'bold', color: 'var(--cth-lemon)' }}>
                  {contextPackage.budgetTokens.toLocaleString()}
                </div>
                <div style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>tokens cap</div>
              </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--cth-ink-200)', paddingBottom: 4 }}>
              <button
                onClick={() => setActiveTab('routing')}
                style={{
                  padding: '4px 10px',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 11,
                  border: 'none',
                  background: activeTab === 'routing' ? 'var(--cth-mint)' : 'transparent',
                  color: activeTab === 'routing' ? 'var(--cth-ink-900)' : 'var(--cth-ink-600)',
                  cursor: 'pointer',
                  fontWeight: activeTab === 'routing' ? 600 : 400
                }}
              >
                Routing Alternatives ({routingResult?.alternatives.length ?? 0})
              </button>
              <button
                onClick={() => setActiveTab('files')}
                style={{
                  padding: '4px 10px',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 11,
                  border: 'none',
                  background: activeTab === 'files' ? 'var(--cth-mint)' : 'transparent',
                  color: activeTab === 'files' ? 'var(--cth-ink-900)' : 'var(--cth-ink-600)',
                  cursor: 'pointer',
                  fontWeight: activeTab === 'files' ? 600 : 400
                }}
              >
                Selected Files ({contextPackage.selectedFiles.length})
              </button>
              <button
                onClick={() => setActiveTab('verify')}
                style={{
                  padding: '4px 10px',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 11,
                  border: 'none',
                  background: activeTab === 'verify' ? 'var(--cth-mint)' : 'transparent',
                  color: activeTab === 'verify' ? 'var(--cth-ink-900)' : 'var(--cth-ink-600)',
                  cursor: 'pointer',
                  fontWeight: activeTab === 'verify' ? 600 : 400
                }}
              >
                Verification Rules ({currentRole?.verificationRules.length ?? 0})
              </button>
              <button
                onClick={() => setActiveTab('raw')}
                style={{
                  padding: '4px 10px',
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 11,
                  border: 'none',
                  background: activeTab === 'raw' ? 'var(--cth-mint)' : 'transparent',
                  color: activeTab === 'raw' ? 'var(--cth-ink-900)' : 'var(--cth-ink-600)',
                  cursor: 'pointer',
                  fontWeight: activeTab === 'raw' ? 600 : 400
                }}
              >
                Raw Assembled Context
              </button>
            </div>

            {/* Tab Contents */}
            {activeTab === 'routing' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {routingResult?.alternatives.map((alt) => (
                  <div
                    key={alt.role.roleId}
                    style={{
                      padding: '6px 10px',
                      background: 'var(--cth-cream-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 11
                    }}
                  >
                    <div>
                      <strong>{alt.role.title}</strong> (@{alt.role.character}) — Score: {alt.score}
                      <div style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>
                        {alt.reasons.join(' • ')}
                      </div>
                    </div>
                    <PixelButton
                      variant="secondary"
                      size="sm"
                      onClick={() => setSelectedRole(alt.role)}
                    >
                      Select Role
                    </PixelButton>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'files' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {contextPackage.items.map((it) => (
                  <div
                    key={it.id}
                    style={{
                      padding: '6px 10px',
                      background: 'var(--cth-cream-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 11
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: 'var(--cth-font-display)',
                          padding: '2px 4px',
                          background:
                            it.tier === 'tier1_full'
                              ? 'var(--cth-mint)'
                              : it.tier === 'tier2_signature'
                              ? 'var(--cth-lemon)'
                              : 'var(--cth-ink-200)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {it.tier.replace('tier', 'T').toUpperCase()}
                      </span>
                      <span style={{ fontFamily: 'monospace', color: 'var(--cth-ink-900)' }}>
                        {it.path || it.name}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--cth-ink-500)', display: 'flex', gap: 8 }}>
                      <span>{it.reason}</span>
                      <span>• est. {it.estimatedTokens} tokens</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'verify' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {currentRole?.verificationRules.map((ruleId) => (
                  <div
                    key={ruleId}
                    style={{
                      padding: '8px 10px',
                      background: 'var(--cth-cream-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                      fontSize: 11,
                      color: 'var(--cth-ink-800)'
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>Rule: {ruleId}</div>
                    <div style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
                      Automated exit code and test runner validation required post-agent completion.
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeTab === 'raw' && (
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  background: 'var(--cth-ink-900)',
                  color: 'var(--cth-cream-100)',
                  fontFamily: 'monospace',
                  fontSize: 10,
                  maxHeight: 220,
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {contextPackage.assembledText}
              </pre>
            )}
          </div>

          {/* Footer Controls */}
          <div
            style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--cth-ink-200)',
              background: 'var(--cth-cream-200)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}
          >
            <PixelButton variant="secondary" size="sm" onClick={onClose} disabled={isExecuting}>
              Cancel
            </PixelButton>

            <div style={{ display: 'flex', gap: 8 }}>
              <PixelButton
                variant="primary"
                size="sm"
                onClick={handleStartAgent}
                disabled={isExecuting}
              >
                {isExecuting ? 'Executing & Verifying...' : `Start Agent (${currentRole?.title || 'Agent'}) →`}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
