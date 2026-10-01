/**
 * Deterministic Project Planner & Task Graph Engine (Phase 8A).
 *
 * Decomposes analyzed projects into structured milestones, tasks, and dependency DAGs
 * with evidence-based progress metrics and TaskRouter role assignment.
 */

import { randomUUID } from 'node:crypto';
import type { Project } from '../../shared/project';
import type { ProjectGraphNode } from '../../shared/graph';
import type { TaskRouter } from '../routing/taskRouter';
import type {
  ProjectPlan,
  ProjectMilestone,
  ProjectTask,
  ProjectPlanProgress,
  TaskStatus,
  MilestoneStatus
} from '../../shared/plan';

export class ProjectPlanner {
  constructor(private taskRouter: TaskRouter) {}

  /**
   * Generate an initial structured milestone and task graph plan for a project.
   */
  generateInitialPlan(project: Project, graphNodes: ProjectGraphNode[] = []): ProjectPlan {
    const domainId = project.domainId;

    let milestoneTemplates: Array<{
      title: string;
      description: string;
      tasks: Array<{
        title: string;
        description: string;
        priority: 'low' | 'medium' | 'high' | 'critical';
        dependencyIndices: number[]; // Relative indices within plan for DAG
      }>;
    }> = [];

    if (domainId === 'ai-ml') {
      milestoneTemplates = [
        {
          title: 'Data Ingestion & Exploratory Analysis',
          description: 'Validate data pipelines, explore dataset distributions, and clean features.',
          tasks: [
            {
              title: 'Inspect dataset schema and data loading pipeline',
              description: 'Verify dataset formats, missing values, and preprocessing pipelines.',
              priority: 'high',
              dependencyIndices: []
            },
            {
              title: 'Perform exploratory data analysis and feature distribution checks',
              description: 'Analyze outlier distributions and compute baseline statistics.',
              priority: 'medium',
              dependencyIndices: [0]
            }
          ]
        },
        {
          title: 'Model Architecture & Training Loop',
          description: 'Define model structure, loss functions, and reproducible training procedures.',
          tasks: [
            {
              title: 'Implement model training and gradient optimization loop',
              description: 'Configure optimizer, learning rate schedule, and checkpoint persistence.',
              priority: 'critical',
              dependencyIndices: [1]
            },
            {
              title: 'Diagnose convergence and gradient stability',
              description: 'Verify absence of NaN losses, gradient explosions, or shape mismatches.',
              priority: 'high',
              dependencyIndices: [2]
            }
          ]
        },
        {
          title: 'Model Evaluation & Benchmarking',
          description: 'Compute evaluation metrics, validation curves, and test generalization.',
          tasks: [
            {
              title: 'Benchmark evaluation accuracy, drift, and validation metrics',
              description: 'Run test set inference and compute evaluation metrics against baseline.',
              priority: 'high',
              dependencyIndices: [3]
            }
          ]
        }
      ];
    } else if (domainId === 'cybersecurity') {
      milestoneTemplates = [
        {
          title: 'Attack Surface & Vulnerability Scanning',
          description: 'Audit third-party dependencies, scan for secret leaks, and analyze entry points.',
          tasks: [
            {
              title: 'Scan codebase for hardcoded secrets and exposed tokens',
              description: 'Check repository files and git history for credential or key leakage.',
              priority: 'critical',
              dependencyIndices: []
            },
            {
              title: 'Perform SAST static analysis for OWASP vulnerabilities',
              description: 'Scan code paths for SQL injection, XSS, CSRF, and insecure deserialization.',
              priority: 'high',
              dependencyIndices: [0]
            }
          ]
        },
        {
          title: 'Security Hardening & Cryptographic Verification',
          description: 'Harden authorization, sanitize request boundaries, and configure secure headers.',
          tasks: [
            {
              title: 'Harden JWT token validation and sanitize input parameters',
              description: 'Enforce cryptographic token signing, expiration checks, and parameter sanitization.',
              priority: 'critical',
              dependencyIndices: [1]
            }
          ]
        },
        {
          title: 'Security Testing & Verification Playbook',
          description: 'Execute automated security test harnesses and compile compliance posture.',
          tasks: [
            {
              title: 'Run fuzzing test harness and authorization boundary checks',
              description: 'Verify system behavior under malformed payloads and unauthorized requests.',
              priority: 'high',
              dependencyIndices: [2]
            },
            {
              title: 'Generate security posture and remediation compliance matrix',
              description: 'Document resolved vulnerabilities, residual risks, and verification results.',
              priority: 'medium',
              dependencyIndices: [3]
            }
          ]
        }
      ];
    } else {
      // Default: Software Engineering
      milestoneTemplates = [
        {
          title: 'Foundation & Architecture Review',
          description: 'Inspect project structure, verify entry points, and validate environment dependencies.',
          tasks: [
            {
              title: 'Review project architecture, entry points, and module structure',
              description: 'Validate codebase organization, configuration settings, and core module dependencies.',
              priority: 'medium',
              dependencyIndices: []
            },
            {
              title: 'Audit project dependencies and package integrity',
              description: 'Verify package manifests, version locks, and dependency health.',
              priority: 'low',
              dependencyIndices: [0]
            }
          ]
        },
        {
          title: 'Core Implementation & Feature Delivery',
          description: 'Implement primary module capabilities, endpoints, and data transformations.',
          tasks: [
            {
              title: 'Implement core application features and API endpoints',
              description: 'Develop required business logic, service handlers, and data persistence layers.',
              priority: 'critical',
              dependencyIndices: [1]
            },
            {
              title: 'Debug edge-case errors and handle runtime exceptions',
              description: 'Identify potential null pointers, boundary errors, and improve fault tolerance.',
              priority: 'high',
              dependencyIndices: [2]
            }
          ]
        },
        {
          title: 'Testing, Quality Assurance & Build Verification',
          description: 'Ensure automated test coverage, regression prevention, and clean build checks.',
          tasks: [
            {
              title: 'Design and execute automated unit and regression test suite',
              description: 'Add focused test assertions covering critical functional paths.',
              priority: 'high',
              dependencyIndices: [3]
            },
            {
              title: 'Verify TypeScript compilation, lint hygiene, and build artifacts',
              description: 'Ensure typecheck cleanly passes with zero errors and clean build output.',
              priority: 'medium',
              dependencyIndices: [4]
            }
          ]
        }
      ];
    }

    const milestones: ProjectMilestone[] = [];
    const tasks: ProjectTask[] = [];
    const taskIndexToIdMap = new Map<number, string>();

    let globalTaskIndex = 0;
    const now = Date.now();

    // First Pass: Instantiate Milestones and Tasks
    for (let mIdx = 0; mIdx < milestoneTemplates.length; mIdx++) {
      const tmpl = milestoneTemplates[mIdx];
      const milestoneId = `m-${mIdx + 1}-${randomUUID().slice(0, 8)}`;
      const milestoneTaskIds: string[] = [];

      for (const tTmpl of tmpl.tasks) {
        const taskId = `task-${globalTaskIndex + 1}-${randomUUID().slice(0, 8)}`;
        taskIndexToIdMap.set(globalTaskIndex, taskId);
        milestoneTaskIds.push(taskId);

        // Determine suggested role via TaskRouter
        const routing = this.taskRouter.routeTask(tTmpl.title, project, graphNodes);
        const suggestedRoleId = routing.recommendedRole.roleId;
        const verificationRules = routing.recommendedRole.verificationRules || [];

        // Find relevant graph nodes
        const relevantGraphNodeIds = graphNodes
          .filter((n) => tTmpl.title.toLowerCase().includes(n.name.toLowerCase()))
          .map((n) => n.id)
          .slice(0, 5);

        tasks.push({
          taskId,
          projectId: project.id,
          milestoneId,
          title: tTmpl.title,
          description: tTmpl.description,
          status: 'pending', // Will be recalculated by dependency resolver
          priority: tTmpl.priority,
          dependencies: [], // Resolved in second pass
          suggestedRoleId,
          verificationRules,
          relevantGraphNodeIds,
          createdAt: now,
          updatedAt: now
        });

        globalTaskIndex++;
      }

      milestones.push({
        milestoneId,
        projectId: project.id,
        title: tmpl.title,
        description: tmpl.description,
        order: mIdx + 1,
        status: 'pending',
        taskIds: milestoneTaskIds
      });
    }

    // Second Pass: Link DAG Dependencies
    let taskIdx = 0;
    for (const tmpl of milestoneTemplates) {
      for (const tTmpl of tmpl.tasks) {
        const currentTask = tasks[taskIdx];
        const resolvedDeps: string[] = [];
        for (const depIdx of tTmpl.dependencyIndices) {
          const depId = taskIndexToIdMap.get(depIdx);
          if (depId && depId !== currentTask.taskId) {
            resolvedDeps.push(depId);
          }
        }
        currentTask.dependencies = resolvedDeps;
        taskIdx++;
      }
    }

    // Validate DAG to prevent cycles
    ProjectPlanner.validateDag(tasks);

    // Resolve initial task statuses based on dependencies
    ProjectPlanner.recomputePlanStatuses(milestones, tasks);

    const progress = ProjectPlanner.computeProgress(milestones, tasks);

    return {
      projectId: project.id,
      projectName: project.name,
      domainId: project.domainId,
      milestones,
      tasks,
      progress,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Recompute task and milestone statuses and progress metrics after any task change.
   */
  static recomputePlanStatuses(milestones: ProjectMilestone[], tasks: ProjectTask[]): void {
    const taskMap = new Map<string, ProjectTask>();
    for (const t of tasks) {
      taskMap.set(t.taskId, t);
    }

    // 1. Update task statuses based on prerequisite completions
    for (const task of tasks) {
      if (task.status === 'completed' || task.status === 'running' || task.status === 'failed') {
        continue;
      }

      const allDepsCompleted = task.dependencies.every((depId) => {
        const dep = taskMap.get(depId);
        return dep && dep.status === 'completed';
      });

      if (allDepsCompleted) {
        if (task.status === 'pending' || task.status === 'blocked') {
          task.status = 'ready';
        }
      } else {
        const anyDepFailed = task.dependencies.some((depId) => {
          const dep = taskMap.get(depId);
          return dep && dep.status === 'failed';
        });

        task.status = anyDepFailed ? 'blocked' : 'pending';
      }
    }

    // 2. Update milestone statuses
    for (const milestone of milestones) {
      const mTasks = milestone.taskIds
        .map((id) => taskMap.get(id))
        .filter((t): t is ProjectTask => t !== undefined);

      if (mTasks.length === 0) {
        milestone.status = 'pending';
      } else if (mTasks.every((t) => t.status === 'completed')) {
        milestone.status = 'completed';
      } else if (mTasks.some((t) => t.status === 'failed' || t.status === 'blocked')) {
        milestone.status = 'blocked';
      } else if (mTasks.some((t) => t.status === 'running' || t.status === 'ready' || t.status === 'completed')) {
        milestone.status = 'in_progress';
      } else {
        milestone.status = 'pending';
      }
    }
  }

  /**
   * Validate that task dependencies form a strictly acyclic DAG.
   * Throws Error if a circular dependency is detected.
   */
  static validateDag(tasks: ProjectTask[]): boolean {
    const taskMap = new Map<string, ProjectTask>();
    const adj = new Map<string, string[]>();

    for (const t of tasks) {
      taskMap.set(t.taskId, t);
      adj.set(t.taskId, [...t.dependencies]);
    }

    const visited = new Set<string>();
    const recStack = new Set<string>();

    function hasCycle(taskId: string): boolean {
      visited.add(taskId);
      recStack.add(taskId);

      const neighbors = adj.get(taskId) || [];
      for (const depId of neighbors) {
        if (!visited.has(depId)) {
          if (hasCycle(depId)) return true;
        } else if (recStack.has(depId)) {
          return true;
        }
      }

      recStack.delete(taskId);
      return false;
    }

    for (const task of tasks) {
      if (!visited.has(task.taskId)) {
        if (hasCycle(task.taskId)) {
          throw new Error(`Circular dependency detected involving task: ${task.taskId} ("${task.title}")`);
        }
      }
    }

    return true;
  }

  /**
   * Compute evidence-based progress metrics.
   */
  static computeProgress(milestones: ProjectMilestone[], tasks: ProjectTask[]): ProjectPlanProgress {
    const totalMilestones = milestones.length;
    const completedMilestones = milestones.filter((m) => m.status === 'completed').length;

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t) => t.status === 'completed').length;
    const readyTasks = tasks.filter((t) => t.status === 'ready').length;
    const blockedTasks = tasks.filter((t) => t.status === 'blocked').length;
    const failedTasks = tasks.filter((t) => t.status === 'failed').length;

    const progressPercentage = totalTasks > 0
      ? Math.round((completedTasks / totalTasks) * 100)
      : 0;

    return {
      totalMilestones,
      completedMilestones,
      totalTasks,
      completedTasks,
      readyTasks,
      blockedTasks,
      failedTasks,
      progressPercentage
    };
  }
}
