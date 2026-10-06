/**
 * Shared types for Task Execution & Verification flow in Nexus (Phase 7C).
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
