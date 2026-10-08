/**
 * Shared types for Task -> Agent Routing in Nexus.
 */

import type { DomainAgentRole, AgentContextStrategy } from './domain';
import type { AgentProvider } from './agentProvider';

export interface AgentRoleCandidate {
  role: DomainAgentRole;
  score: number;
  reasons: string[];
}

export interface PreparedAgentConfig {
  roleId: string;
  domainId: string;
  title: string;
  systemPromptPreamble: string;
  recommendedSkills: string[];
  recommendedTools: string[];
  verificationRules: string[];
  preferredProvider: AgentProvider;
  preferredModel?: string;
  defaultBudgetTokens: number;
}

export interface TaskRoutingResult {
  taskId?: string;
  task: string;
  projectId: string;
  recommendedRole: DomainAgentRole;
  alternatives: AgentRoleCandidate[];
  score: number;
  reasons: string[];
  contextStrategy: AgentContextStrategy;
  preparedConfig: PreparedAgentConfig;
  routedAt: number;
}
