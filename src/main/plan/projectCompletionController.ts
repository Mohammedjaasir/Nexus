/**
 * Legacy completion heuristics (Phase 9A), kept only as pure functions under
 * unit test. Nothing in the app calls them since B0a: the step runner that
 * marked tasks completed when a shell command exited 0 was removed, and with it
 * the in-memory repair-attempt counter. Completion rules arrive with the
 * platform engine (B1).
 */

import type { Project } from '../../shared/project';
import type { ProjectPlan, ProjectTask } from '../../shared/plan';
import type { GoalAnalysisResult } from '../../shared/goal';
import type { ProjectGapAnalysisResult } from '../../shared/gap';
import type { ProjectState, ProjectCompletionContract } from '../../shared/completion';

export class ProjectCompletionController {
  /**
   * Find the highest-priority ready task in the project plan.
   */
  findNextReadyTask(plan: ProjectPlan): { task: ProjectTask | null; index: number } {
    const priorityWeight: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1
    };

    const readyTasks = plan.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.status === 'ready' || task.status === 'failed');

    if (readyTasks.length === 0) {
      return { task: null, index: -1 };
    }

    readyTasks.sort((a, b) => {
      const weightA = priorityWeight[a.task.priority] || 1;
      const weightB = priorityWeight[b.task.priority] || 1;
      if (weightB !== weightA) {
        return weightB - weightA;
      }
      return a.index - b.index;
    });

    return readyTasks[0];
  }

  /**
   * Evaluate whether the project goal meets the strict completion contract.
   */
  evaluateCompletionContract(
    project: Project,
    goalAnalysis: GoalAnalysisResult | null,
    gapAnalysis: ProjectGapAnalysisResult | null,
    plan: ProjectPlan,
    lastVerificationPassed: boolean = true
  ): ProjectCompletionContract {
    const reasons: string[] = [];

    // 1. Required capabilities completed
    const requiredCaps = goalAnalysis?.evaluatedCapabilities.filter((c) => c.required) || [];
    const requiredCapabilitiesCompleted = requiredCaps.length > 0 &&
      requiredCaps.every((c) => c.status === 'completed');

    if (requiredCapabilitiesCompleted) {
      reasons.push(`All ${requiredCaps.length} required goal capabilities completed`);
    } else {
      const missingCaps = requiredCaps.filter((c) => c.status !== 'completed').map((c) => c.name);
      reasons.push(`Incomplete capabilities: ${missingCaps.join(', ') || 'none defined'}`);
    }

    // 2. No critical gaps
    const criticalGaps = gapAnalysis?.gaps.filter((g) => g.isCritical) || [];
    const noCriticalGaps = criticalGaps.length === 0 ||
      criticalGaps.every((g) => g.status === 'completed');

    if (noCriticalGaps) {
      reasons.push('No critical capability gaps remaining');
    } else {
      const remainingGaps = criticalGaps.filter((g) => g.status !== 'completed').map((g) => g.title);
      reasons.push(`Critical gaps remaining: ${remainingGaps.join(', ')}`);
    }

    // 3. No blocked tasks
    const blockedTasks = plan.tasks.filter((t) => t.status === 'blocked' || t.status === 'failed');
    const noBlockedTasks = blockedTasks.length === 0;

    if (noBlockedTasks) {
      reasons.push('No blocked or failed tasks in plan');
    } else {
      reasons.push(`${blockedTasks.length} task(s) currently blocked or failed`);
    }

    // 4. Verification rules & tests
    const verificationRulesPassed = lastVerificationPassed;
    const testsPassed = (project.health?.hasTests ?? true) && lastVerificationPassed;

    if (verificationRulesPassed && testsPassed) {
      reasons.push('Verification rules and automated tests pass');
    } else {
      reasons.push('Verification rules or test assertions failed');
    }

    // 5. Success criteria
    const successCriteriaSatisfied = requiredCapabilitiesCompleted && noCriticalGaps && noBlockedTasks;
    if (successCriteriaSatisfied) {
      reasons.push('Project success criteria satisfied');
    }

    const isGoalComplete =
      requiredCapabilitiesCompleted &&
      noCriticalGaps &&
      noBlockedTasks &&
      verificationRulesPassed &&
      testsPassed &&
      successCriteriaSatisfied;

    return {
      requiredCapabilitiesCompleted,
      noCriticalGaps,
      noBlockedTasks,
      verificationRulesPassed,
      testsPassed,
      successCriteriaSatisfied,
      isGoalComplete,
      reasons
    };
  }

  /**
   * Determine project state from plan, repair limits, and completion contract.
   */
  determineProjectState(
    contract: ProjectCompletionContract,
    plan: ProjectPlan
  ): ProjectState {
    if (contract.isGoalComplete) {
      return 'completed';
    }

    const hasNeedsReview = plan.tasks.some((t) => t.status === 'needs_review');
    if (hasNeedsReview) {
      return 'needs_review';
    }

    const hasBlocked = plan.tasks.some((t) => t.status === 'blocked' || t.status === 'failed');
    if (hasBlocked) {
      return 'blocked';
    }

    const hasRunning = plan.tasks.some((t) => t.status === 'running');
    if (hasRunning) {
      return 'in_progress';
    }

    const hasReady = plan.tasks.some((t) => t.status === 'ready');
    if (hasReady) {
      return 'ready';
    }

    return 'in_progress';
  }
}
