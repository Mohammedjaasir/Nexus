/**
 * Shared types for Goal-Aware Project Planning in Munder Difflin (Phase 8C).
 */

export interface GoalCapability {
  capabilityId: string;
  name: string;
  description: string;
  category: string;
  required: boolean;
  verificationRules: string[];
  relevantDomainRoles: string[];
  relevantGraphPatterns: string[];
  status?: 'completed' | 'in_progress' | 'missing' | 'blocked' | 'unknown';
  evidence?: string[];
  confidence?: number; // 0.0 to 1.0
  relevantGraphNodeIds?: string[];
  linkedTaskId?: string;
}

export interface ProjectGoal {
  goalId: string;
  projectId: string;
  title: string;
  description: string;
  domainId: string;
  requiredCapabilities: GoalCapability[];
  successCriteria: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GoalAnalysisResult {
  goal: ProjectGoal;
  evaluatedCapabilities: GoalCapability[];
  goalReadinessScore: number; // 0 to 100 percentage
  completedCapabilitiesCount: number;
  inProgressCapabilitiesCount: number;
  missingCapabilitiesCount: number;
  blockedCapabilitiesCount: number;
  analyzedAt: number;
}
