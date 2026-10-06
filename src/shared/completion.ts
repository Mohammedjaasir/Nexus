/**
 * Legacy completion-contract types (Phase 9A), used only by the unit-tested
 * heuristics in main/plan/projectCompletionController.ts. No IPC since B0a.
 */

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
