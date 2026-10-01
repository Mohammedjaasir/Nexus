/**
 * Shared types for Phase 9: Complete Project — Verified Execution.
 */

import type { ProjectTask, ProjectPlan } from './plan';
import type { TaskExecutionPlan, TaskExecutionResult, TaskVerificationSummary } from './execution';
import type { GoalAnalysisResult, ProjectGoal } from './goal';
import type { ProjectGapAnalysisResult } from './gap';

export type ProjectState =
  | 'draft'
  | 'analyzing'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'needs_review';

export interface ProjectCompletionContract {
  requiredCapabilitiesCompleted: boolean;
  noCriticalGaps: boolean;
  noBlockedTasks: boolean;
  verificationRulesPassed: boolean;
  testsPassed: boolean;
  successCriteriaSatisfied: boolean;
  isGoalComplete: boolean;
  reasons: string[];
}

export interface NextTaskResult {
  projectId: string;
  projectState: ProjectState;
  task: ProjectTask | null;
  executionPlan: TaskExecutionPlan | null;
  contract: ProjectCompletionContract;
  taskIndex: number;
  totalTasks: number;
}

export interface ProjectStepResult {
  projectId: string;
  taskId: string;
  taskTitle: string;
  executionResult: TaskExecutionResult;
  repairAttempts: number;
  updatedGraphNodesCount: number;
  updatedGoalAnalysis: GoalAnalysisResult;
  updatedGaps: ProjectGapAnalysisResult;
  updatedPlan: ProjectPlan;
  contract: ProjectCompletionContract;
  projectState: ProjectState;
  nextReadyTask: ProjectTask | null;
}
