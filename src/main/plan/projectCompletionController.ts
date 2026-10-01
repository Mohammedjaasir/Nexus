/**
 * Controlled Project Completion & Verified Execution Engine (Phase 9A).
 *
 * Coordinates single-step execution, evidence-based verification, incremental graph updates,
 * failure/retry repair limits (max 2), and goal completion contract evaluation.
 */

import { randomUUID } from 'node:crypto';
import type { PersistStore } from '../db';
import type { Project } from '../../shared/project';
import type { ProjectPlan, ProjectTask } from '../../shared/plan';
import type { ProjectGraphNode, ProjectGraphEdge } from '../../shared/graph';
import type { GoalAnalysisResult } from '../../shared/goal';
import type { ProjectGapAnalysisResult } from '../../shared/gap';
import type {
  ProjectState,
  ProjectCompletionContract,
  NextTaskResult,
  ProjectStepResult
} from '../../shared/completion';
import type { TaskExecutionCoordinator } from '../execution/taskExecutionCoordinator';
import { ProjectPlanner } from './projectPlanner';
import type { ProjectGapAnalyzer } from './projectGapAnalyzer';
import type { GoalPlanner } from './goalPlanner';
import { updateProjectKnowledgeGraphIncremental } from '../project/projectGraphExtractor';

export class ProjectCompletionController {
  private repairAttempts = new Map<string, number>();

  constructor(
    private store: PersistStore,
    private executionCoordinator: TaskExecutionCoordinator,
    private gapAnalyzer: ProjectGapAnalyzer,
    private goalPlanner: GoalPlanner
  ) {}

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
      .filter(({ task }) => {
        if (task.status === 'ready') return true;
        if (task.status === 'failed') {
          const attempts = this.repairAttempts.get(task.taskId) || 0;
          return attempts < 2;
        }
        return false;
      });

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

    const hasNeedsReview = plan.tasks.some((t) => {
      const attempts = this.repairAttempts.get(t.taskId) || 0;
      return t.status === 'needs_review' || (t.status === 'failed' && attempts >= 2);
    });
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

  /**
   * Retrieve the next ready task and prepared execution plan.
   */
  async getNextTask(projectId: string): Promise<NextTaskResult | null> {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    let plan = this.store.getProjectPlan(projectId);
    if (!plan) return null;

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const graphEdges = this.store.getProjectGraphEdges(projectId);

    const goal = this.store.getProjectGoal(projectId);
    const goalAnalysis = goal
      ? this.goalPlanner.evaluateGoal(goal, project, graphNodes, graphEdges, plan)
      : null;

    const gapAnalysis = this.gapAnalyzer.analyzeGaps(project, graphNodes, graphEdges, plan);

    const { task, index } = this.findNextReadyTask(plan);
    const contract = this.evaluateCompletionContract(project, goalAnalysis, gapAnalysis, plan, true);
    const projectState = this.determineProjectState(contract, plan);

    let executionPlan = null;
    if (task) {
      executionPlan = await this.executionCoordinator.prepareExecutionPlan(
        projectId,
        task.title,
        {
          roleId: task.suggestedRoleId
        }
      );
    }

    return {
      projectId,
      projectState,
      task,
      executionPlan,
      contract,
      taskIndex: index,
      totalTasks: plan.tasks.length
    };
  }

  /**
   * Execute one controlled step in the project completion pipeline.
   */
  async executeStep(
    projectId: string,
    agentActionRunner?: () => Promise<string[]>,
    customVerificationCommand?: string
  ): Promise<ProjectStepResult | null> {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    const plan = this.store.getProjectPlan(projectId);
    if (!plan) return null;

    const { task } = this.findNextReadyTask(plan);
    if (!task) return null;

    // 1. Prepare and execute task plan through Phase 7C coordinator
    const executionPlan = await this.executionCoordinator.prepareExecutionPlan(
      projectId,
      task.title,
      {
        roleId: task.suggestedRoleId
      }
    );

    task.status = 'running';
    task.updatedAt = Date.now();
    this.store.saveProjectPlan(plan);

    const executionResult = await this.executionCoordinator.executePlan(
      executionPlan,
      agentActionRunner,
      customVerificationCommand
    );

    const currentAttempts = (this.repairAttempts.get(task.taskId) || 0) + 1;
    this.repairAttempts.set(task.taskId, currentAttempts);

    const isVerificationPassed = executionResult.verification.status === 'success';

    // 2. Handle verification outcome & retry limits
    if (isVerificationPassed) {
      task.status = 'completed';
      task.updatedAt = Date.now();
      this.repairAttempts.delete(task.taskId);

      // Incremental Knowledge Graph Update: parse and update modified/added files
      if (executionResult.changedFiles && executionResult.changedFiles.length > 0) {
        const existingNodes = this.store.getProjectGraphNodes(projectId);
        const existingEdges = this.store.getProjectGraphEdges(projectId);

        const updated = updateProjectKnowledgeGraphIncremental(
          projectId,
          project.rootPath,
          { nodes: existingNodes, edges: existingEdges },
          executionResult.changedFiles.map((f) => ({ path: f, changeType: 'modified' }))
        );

        this.store.saveProjectGraph(projectId, updated.nodes, updated.edges);
      }
    } else {
      if (currentAttempts >= 2) {
        task.status = 'needs_review';
      } else {
        task.status = 'failed';
      }
      task.updatedAt = Date.now();
    }

    // 3. Re-evaluate capabilities and reconcile plan
    const updatedGraphNodes = this.store.getProjectGraphNodes(projectId);
    const updatedGraphEdges = this.store.getProjectGraphEdges(projectId);

    const goal = this.store.getProjectGoal(projectId);
    let updatedGoalAnalysis = goal
      ? this.goalPlanner.evaluateGoal(goal, project, updatedGraphNodes, updatedGraphEdges, plan)
      : {
          goal: { goalId: '', projectId, title: '', description: '', domainId: project.domainId, requiredCapabilities: [], successCriteria: [], createdAt: 0, updatedAt: 0 },
          evaluatedCapabilities: [],
          goalReadinessScore: 0,
          completedCapabilitiesCount: 0,
          inProgressCapabilitiesCount: 0,
          missingCapabilitiesCount: 0,
          blockedCapabilitiesCount: 0,
          analyzedAt: Date.now()
        };

    const updatedGaps = this.gapAnalyzer.analyzeGaps(project, updatedGraphNodes, updatedGraphEdges, plan);

    ProjectPlanner.recomputePlanStatuses(plan.milestones, plan.tasks);
    plan.progress = ProjectPlanner.computeProgress(plan.milestones, plan.tasks);
    this.store.saveProjectPlan(plan);
    this.store.saveProjectGapAnalysis(updatedGaps);

    const contract = this.evaluateCompletionContract(
      project,
      updatedGoalAnalysis,
      updatedGaps,
      plan,
      isVerificationPassed
    );
    const projectState = this.determineProjectState(contract, plan);
    const { task: nextReadyTask } = this.findNextReadyTask(plan);

    return {
      projectId,
      taskId: task.taskId,
      taskTitle: task.title,
      executionResult,
      repairAttempts: currentAttempts,
      updatedGraphNodesCount: updatedGraphNodes.length,
      updatedGoalAnalysis,
      updatedGaps,
      updatedPlan: plan,
      contract,
      projectState,
      nextReadyTask
    };
  }
}
