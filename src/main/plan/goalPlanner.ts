/**
 * Deterministic Goal-Aware Project Planning Engine (Phase 8C).
 *
 * Translates explicit user project goals into structured capabilities,
 * evaluates capability completeness against repository evidence and knowledge graph,
 * and generates tasks only for missing / incomplete capabilities without duplicates.
 */

import { randomUUID } from 'node:crypto';
import type { Project } from '../../shared/project';
import type { ProjectGraphNode, ProjectGraphEdge } from '../../shared/graph';
import type { ProjectPlan, ProjectTask, ProjectMilestone } from '../../shared/plan';
import { ProjectPlanner } from './projectPlanner';
import type {
  ProjectGoal,
  GoalCapability,
  GoalAnalysisResult
} from '../../shared/goal';

export class GoalPlanner {
  /**
   * Derive structured required capabilities and success criteria from a goal title and domain.
   */
  deriveCapabilitiesForGoal(
    goalTitle: string,
    domainId: string
  ): { capabilities: GoalCapability[]; successCriteria: string[] } {
    const titleLower = goalTitle.toLowerCase();

    if (domainId === 'ai-ml' || titleLower.includes('ocr') || titleLower.includes('model') || titleLower.includes('fraud') || titleLower.includes('ml')) {
      return {
        capabilities: [
          {
            capabilityId: 'cap-aiml-prep',
            name: 'Dataset Ingestion & Preprocessing',
            description: 'Feature normalization, data loading pipeline, and schema validation.',
            category: 'data_pipeline',
            required: true,
            verificationRules: ['verify-data-schema', 'verify-pipeline-load'],
            relevantDomainRoles: ['aiml-data-scientist', 'aiml-engineer'],
            relevantGraphPatterns: ['data', 'dataset', 'pipeline', 'loader', 'preprocess']
          },
          {
            capabilityId: 'cap-aiml-inference',
            name: 'Model Architecture & Inference Pipeline',
            description: 'Core neural network model, inference forward pass, and checkpoint loading.',
            category: 'model',
            required: true,
            verificationRules: ['verify-model-forward', 'verify-weights-loaded'],
            relevantDomainRoles: ['aiml-engineer', 'aiml-debugger'],
            relevantGraphPatterns: ['model', 'inference', 'forward', 'predict', 'train', 'net']
          },
          {
            capabilityId: 'cap-aiml-api',
            name: 'REST / Service API Layer',
            description: 'API routing handlers, request parsing, and inference payload dispatching.',
            category: 'implementation',
            required: true,
            verificationRules: ['verify-api-endpoint', 'verify-response-payload'],
            relevantDomainRoles: ['sde-engineer', 'aiml-engineer'],
            relevantGraphPatterns: ['api', 'route', 'endpoint', 'server', 'app', 'service']
          },
          {
            capabilityId: 'cap-aiml-validation',
            name: 'Validation Metrics & Benchmark Evaluation',
            description: 'Model accuracy metrics, error distributions, and benchmark thresholds.',
            category: 'testing',
            required: true,
            verificationRules: ['verify-eval-metrics', 'verify-benchmark-pass'],
            relevantDomainRoles: ['aiml-evaluator', 'aiml-data-scientist'],
            relevantGraphPatterns: ['eval', 'metric', 'benchmark', 'accuracy', 'score']
          },
          {
            capabilityId: 'cap-aiml-testing',
            name: 'Automated Unit & Regression Tests',
            description: 'Automated test suites verifying component execution and preventing regression.',
            category: 'testing',
            required: true,
            verificationRules: ['verify-unit-tests'],
            relevantDomainRoles: ['sde-tester', 'aiml-evaluator'],
            relevantGraphPatterns: ['test', 'spec', 'runner']
          },
          {
            capabilityId: 'cap-aiml-deployment',
            name: 'Production Packaging & Deployment',
            description: 'Container definitions, model artifact export, and production runtime configuration.',
            category: 'deployment',
            required: false,
            verificationRules: ['verify-build-artifacts'],
            relevantDomainRoles: ['sde-reviewer', 'sde-engineer'],
            relevantGraphPatterns: ['docker', 'deploy', 'export', 'onnx', 'package']
          }
        ],
        successCriteria: [
          'Model forward inference executes cleanly on valid input tensors',
          'API endpoint receives payload, runs inference, and returns formatted predictions',
          'Automated test suites pass with zero regressions',
          'Benchmark validation score exceeds baseline accuracy threshold'
        ]
      };
    }

    if (domainId === 'cybersecurity' || titleLower.includes('security') || titleLower.includes('auth') || titleLower.includes('audit')) {
      return {
        capabilities: [
          {
            capabilityId: 'cap-sec-audit',
            name: 'Vulnerability & Secret Scanning',
            description: 'Static analysis for hardcoded secrets, exposed credentials, and dependency CVEs.',
            category: 'security',
            required: true,
            verificationRules: ['verify-secret-scan', 'verify-dependency-audit'],
            relevantDomainRoles: ['sec-analyst', 'sec-auditor'],
            relevantGraphPatterns: ['secret', 'token', 'auth', 'config', 'env']
          },
          {
            capabilityId: 'cap-sec-auth',
            name: 'Authentication & Cryptographic Token Hardening',
            description: 'Enforce JWT cryptographic signature verification, expiration checks, and token rotation.',
            category: 'security',
            required: true,
            verificationRules: ['verify-jwt-validation', 'verify-auth-flow'],
            relevantDomainRoles: ['sec-coder', 'sec-analyst'],
            relevantGraphPatterns: ['jwt', 'auth', 'session', 'crypto', 'bearer']
          },
          {
            capabilityId: 'cap-sec-sanitization',
            name: 'Input Boundary Sanitization & CSRF Prevention',
            description: 'Parameter sanitization against SQL injection, XSS, and unauthorized path traversal.',
            category: 'security',
            required: true,
            verificationRules: ['verify-input-sanitization'],
            relevantDomainRoles: ['sec-coder', 'sde-engineer'],
            relevantGraphPatterns: ['sanitize', 'escape', 'validate', 'middleware', 'csrf']
          },
          {
            capabilityId: 'cap-sec-testing',
            name: 'Security Test Harness & Boundary Fuzzing',
            description: 'Automated test suite asserting boundary defenses under malformed inputs.',
            category: 'testing',
            required: true,
            verificationRules: ['verify-fuzzing-harness'],
            relevantDomainRoles: ['sec-pentester', 'sde-tester'],
            relevantGraphPatterns: ['test', 'fuzz', 'spec', 'security_test']
          }
        ],
        successCriteria: [
          'Zero hardcoded credentials or unmasked tokens in source files',
          'JWT authentication enforces signature and expiration validation',
          'Malformed payloads are rejected at input boundaries with 400 Bad Request',
          'Security regression test suite passes cleanly'
        ]
      };
    }

    // Default: Software Engineering
    return {
      capabilities: [
        {
          capabilityId: 'cap-sde-architecture',
          name: 'Core Architecture & Entry Point Configuration',
          description: 'Package manifest dependencies, clean entry point scripts, and environment setup.',
          category: 'architecture',
          required: true,
          verificationRules: ['verify-entry-points', 'verify-dependencies'],
          relevantDomainRoles: ['sde-planner', 'sde-reviewer'],
          relevantGraphPatterns: ['index', 'main', 'server', 'app', 'config']
        },
        {
          capabilityId: 'cap-sde-services',
          name: 'Service Logic & API Endpoints',
          description: 'Core application services, business logic handlers, and request dispatchers.',
          category: 'implementation',
          required: true,
          verificationRules: ['verify-service-handlers'],
          relevantDomainRoles: ['sde-engineer', 'sde-debugger'],
          relevantGraphPatterns: ['service', 'api', 'controller', 'handler', 'route', 'core']
        },
        {
          capabilityId: 'cap-sde-testing',
          name: 'Automated Test Suite & Verification Rules',
          description: 'Unit and integration test suites covering critical functional paths.',
          category: 'testing',
          required: true,
          verificationRules: ['verify-unit-tests'],
          relevantDomainRoles: ['sde-tester', 'sde-engineer'],
          relevantGraphPatterns: ['test', 'spec', 'runner']
        },
        {
          capabilityId: 'cap-sde-typecheck',
          name: 'TypeScript Compilation & Lint Hygiene',
          description: 'Type safety checks with 0 TypeScript compiler errors and clean code hygiene.',
          category: 'testing',
          required: true,
          verificationRules: ['verify-typecheck'],
          relevantDomainRoles: ['sde-reviewer', 'sde-engineer'],
          relevantGraphPatterns: ['tsconfig', 'eslint', 'prettier', 'types']
        },
        {
          capabilityId: 'cap-sde-deployment',
          name: 'Build Artifacts & Packaging',
          description: 'Production bundling, build artifacts, and container/release packaging.',
          category: 'deployment',
          required: false,
          verificationRules: ['verify-build-output'],
          relevantDomainRoles: ['sde-reviewer', 'sde-engineer'],
          relevantGraphPatterns: ['build', 'dist', 'bundle', 'docker', 'workflow']
        }
      ],
      successCriteria: [
        'Core services and handlers execute with proper error handling',
        'Automated test suite executes and passes 100% of test cases',
        'TypeScript compilation exits with code 0 and zero type errors',
        'Build artifacts generate cleanly without packaging warnings'
      ]
    };
  }

  /**
   * Create a structured ProjectGoal for a project.
   */
  createProjectGoal(
    projectId: string,
    title: string,
    description: string = '',
    domainId: string
  ): ProjectGoal {
    const { capabilities, successCriteria } = this.deriveCapabilitiesForGoal(title, domainId);
    const now = Date.now();

    return {
      goalId: `goal-${randomUUID().slice(0, 8)}`,
      projectId,
      title,
      description: description || `Project goal: ${title}`,
      domainId,
      requiredCapabilities: capabilities,
      successCriteria,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Evaluate a ProjectGoal against repository files, knowledge graph, and existing plan.
   */
  evaluateGoal(
    goal: ProjectGoal,
    project: Project,
    graphNodes: ProjectGraphNode[] = [],
    graphEdges: ProjectGraphEdge[] = [],
    existingPlan?: ProjectPlan | null
  ): GoalAnalysisResult {
    const evaluatedCapabilities: GoalCapability[] = [];
    const existingTasks = existingPlan?.tasks || [];

    for (const cap of goal.requiredCapabilities) {
      const patterns = cap.relevantGraphPatterns.map((p) => p.toLowerCase());

      // 1. Find matching graph nodes
      const matchingNodes = graphNodes.filter((n) => {
        const nameLower = n.name.toLowerCase();
        const pathLower = (n.path || '').toLowerCase();
        return patterns.some((p) => nameLower.includes(p) || pathLower.includes(p));
      });

      // 2. Find linked plan task
      const linkedTask = existingTasks.find((t) => {
        const titleLower = t.title.toLowerCase();
        return patterns.some((p) => titleLower.includes(p)) || titleLower.includes(cap.name.toLowerCase());
      });

      const evidence: string[] = [];
      let status: 'completed' | 'in_progress' | 'missing' | 'blocked' | 'unknown' = 'unknown';
      let confidence = 0.5;

      // Check specific categories
      if (cap.category === 'architecture') {
        const hasEntry = project.entryPoints && project.entryPoints.length > 0;
        if (hasEntry && matchingNodes.length > 0) {
          status = 'completed';
          confidence = 0.95;
          evidence.push(`Found entry point(s): ${project.entryPoints.join(', ')}`);
          evidence.push(`Matched ${matchingNodes.length} architecture node(s) in graph`);
        } else {
          status = 'missing';
          confidence = 0.85;
          evidence.push('No recognized entry points matching architecture patterns');
        }
      } else if (cap.category === 'testing') {
        const hasTests = (project.testSuites && project.testSuites.length > 0) ||
          matchingNodes.some((n) => n.kind === 'test_suite' || n.kind === 'test_case');
        if (hasTests) {
          status = 'completed';
          confidence = 0.95;
          evidence.push(`Configured test runner with ${project.testSuites?.length || 1} suite(s)`);
          evidence.push(`Matched ${matchingNodes.length} test node(s) in graph`);
        } else {
          status = 'missing';
          confidence = 0.9;
          evidence.push('No test suites or test runner files identified');
        }
      } else if (cap.category === 'security') {
        if (matchingNodes.length >= 2) {
          status = 'completed';
          confidence = 0.9;
          evidence.push(`Matched ${matchingNodes.length} security/auth node(s): ${matchingNodes.slice(0, 2).map((n) => n.name).join(', ')}`);
        } else if (matchingNodes.length === 1) {
          status = 'in_progress';
          confidence = 0.75;
          evidence.push(`Partial security component detected: ${matchingNodes[0].name}`);
        } else {
          status = 'missing';
          confidence = 0.85;
          evidence.push('No security validation or cryptographic hardening nodes found');
        }
      } else {
        // Implementation / Data Pipeline / Model / Deployment
        if (matchingNodes.length >= 2) {
          status = 'completed';
          confidence = 0.9;
          evidence.push(`Matched ${matchingNodes.length} functional symbol(s) in graph: ${matchingNodes.slice(0, 2).map((n) => n.name).join(', ')}`);
        } else if (matchingNodes.length === 1) {
          status = 'in_progress';
          confidence = 0.75;
          evidence.push(`Partial capability implementation mapped (${matchingNodes.length} node(s))`);
        } else {
          status = 'missing';
          confidence = 0.85;
          evidence.push(`No graph nodes found matching patterns: ${patterns.slice(0, 3).join(', ')}`);
        }
      }

      // If existing task was completed by user, respect task completion
      if (linkedTask && linkedTask.status === 'completed') {
        status = 'completed';
        evidence.push(`Plan task "${linkedTask.title}" marked completed`);
      } else if (linkedTask && linkedTask.status === 'failed') {
        status = 'blocked';
        evidence.push(`Plan task "${linkedTask.title}" is in failed state`);
      }

      evaluatedCapabilities.push({
        ...cap,
        status,
        evidence,
        confidence,
        relevantGraphNodeIds: matchingNodes.map((n) => n.id).slice(0, 4),
        linkedTaskId: linkedTask?.taskId
      });
    }

    const completedCount = evaluatedCapabilities.filter((c) => c.status === 'completed').length;
    const inProgressCount = evaluatedCapabilities.filter((c) => c.status === 'in_progress').length;
    const missingCount = evaluatedCapabilities.filter((c) => c.status === 'missing').length;
    const blockedCount = evaluatedCapabilities.filter((c) => c.status === 'blocked').length;

    const total = evaluatedCapabilities.length || 1;
    const goalReadinessScore = Math.round(((completedCount + inProgressCount * 0.5) / total) * 100);

    return {
      goal,
      evaluatedCapabilities,
      goalReadinessScore,
      completedCapabilitiesCount: completedCount,
      inProgressCapabilitiesCount: inProgressCount,
      missingCapabilitiesCount: missingCount,
      blockedCapabilitiesCount: blockedCount,
      analyzedAt: Date.now()
    };
  }

  /**
   * Reconcile ProjectPlan against evaluated goal capabilities, generating tasks ONLY for missing work.
   */
  reconcileGoalPlan(
    goal: ProjectGoal,
    evaluatedCapabilities: GoalCapability[],
    existingPlan: ProjectPlan,
    project: Project
  ): ProjectPlan {
    const existingTasks = [...existingPlan.tasks];
    const taskMap = new Map<string, ProjectTask>();
    for (const t of existingTasks) {
      taskMap.set(t.taskId, t);
    }

    const now = Date.now();

    for (const cap of evaluatedCapabilities) {
      // If capability is already completed, mark matching task as completed if pending
      if (cap.status === 'completed') {
        if (cap.linkedTaskId && taskMap.has(cap.linkedTaskId)) {
          const task = taskMap.get(cap.linkedTaskId)!;
          if (task.status === 'pending' || task.status === 'ready') {
            task.status = 'completed';
            task.updatedAt = now;
          }
        }
      } else if (cap.status === 'missing' || cap.status === 'in_progress') {
        // If missing or in progress, ensure a plan task exists (prevent duplicates)
        const alreadyHasTask = existingTasks.some((t) =>
          t.taskId === cap.linkedTaskId ||
          t.title.toLowerCase().includes(cap.name.toLowerCase()) ||
          cap.name.toLowerCase().includes(t.title.toLowerCase())
        );

        if (!alreadyHasTask && existingPlan.milestones.length > 0) {
          const targetMilestone = existingPlan.milestones[existingPlan.milestones.length - 1];
          const newTaskId = `task-goal-${randomUUID().slice(0, 8)}`;

          const newTask: ProjectTask = {
            taskId: newTaskId,
            projectId: project.id,
            milestoneId: targetMilestone.milestoneId,
            title: `Deliver Goal Capability: ${cap.name}`,
            description: cap.description,
            status: 'pending',
            priority: cap.required ? 'high' : 'medium',
            dependencies: targetMilestone.taskIds.length > 0 ? [targetMilestone.taskIds[targetMilestone.taskIds.length - 1]] : [],
            suggestedRoleId: cap.relevantDomainRoles[0] || 'sde-engineer',
            verificationRules: cap.verificationRules,
            relevantGraphNodeIds: cap.relevantGraphNodeIds || [],
            createdAt: now,
            updatedAt: now
          };

          targetMilestone.taskIds.push(newTaskId);
          existingTasks.push(newTask);
          taskMap.set(newTaskId, newTask);
          cap.linkedTaskId = newTaskId;
        }
      }
    }

    ProjectPlanner.recomputePlanStatuses(existingPlan.milestones, existingTasks);
    const progress = ProjectPlanner.computeProgress(existingPlan.milestones, existingTasks);

    existingPlan.tasks = existingTasks;
    existingPlan.progress = progress;
    existingPlan.updatedAt = now;

    return existingPlan;
  }
}
