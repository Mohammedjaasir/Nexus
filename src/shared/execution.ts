/**
 * Shared types for Task Execution & Verification flow in Munder Difflin (Phase 7C).
 */

import type { AgentProvider } from './agentProvider';
import type { DomainAgentRole } from './domain';
import type { ContextPackage } from './context';
import type { TaskRoutingResult } from './routing';

export interface TaskExecutionPlan {
  projectId: string;
  task: string;
  role: DomainAgentRole;
  routing: TaskRoutingResult;
  contextPackage: ContextPackage;
  selectedProvider: AgentProvider;
  selectedModel?: string;
  assembledPrompt: string;
  verificationRuleIds: string[];
}

export interface TaskVerificationRuleResult {
  ruleId: string;
  ruleName: string;
  command: string;
  exitCode: number;
  output: string;
  passed: boolean;
}

export type TaskVerificationStatus = 'success' | 'failed' | 'needs_review';

export interface TaskVerificationSummary {
  status: TaskVerificationStatus;
  summary: string;
  rules: TaskVerificationRuleResult[];
  testsExecuted: number;
  testsPassed: number;
  testsFailed: number;
}

export interface TaskExecutionResult {
  taskId: string;
  projectId: string;
  projectName: string;
  task: string;
  role: DomainAgentRole;
  provider: AgentProvider;
  model?: string;
  contextTokens: number;
  contextReductionPercentage: number;
  changedFiles: string[];
  verification: TaskVerificationSummary;
  executionLatencyMs: number;
  completedAt: number;
}
