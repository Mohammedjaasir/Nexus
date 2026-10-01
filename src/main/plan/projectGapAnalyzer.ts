/**
 * Deterministic Project Gap Analysis and Plan Reconciliation Engine (Phase 8B).
 *
 * Inspects real project files, knowledge graph, tests, and git state to identify
 * completed, in-progress, missing, and blocked capabilities, calculating evidence-based
 * completion confidence and reconciling with the ProjectPlan.
 */

import { randomUUID } from 'node:crypto';
import type { Project } from '../../shared/project';
import type { ProjectGraphNode, ProjectGraphEdge } from '../../shared/graph';
import type { ProjectPlan, ProjectTask, ProjectMilestone } from '../../shared/plan';
import { ProjectPlanner } from './projectPlanner';
import type {
  ProjectGap,
  ProjectGapAnalysisResult,
  GapCategory,
  GapStatus,
  ConfidenceBreakdown
} from '../../shared/gap';

export class ProjectGapAnalyzer {
  /**
   * Deterministically analyze project capabilities, missing areas, and completion confidence.
   */
  analyzeGaps(
    project: Project,
    graphNodes: ProjectGraphNode[] = [],
    graphEdges: ProjectGraphEdge[] = [],
    existingPlan?: ProjectPlan | null
  ): ProjectGapAnalysisResult {
    const gaps: ProjectGap[] = [];
    const domainId = project.domainId;
    const now = Date.now();

    // Map existing tasks by title/keyword for quick association
    const existingTasks = existingPlan?.tasks || [];
    const findMatchingTaskId = (keywords: string[]): string | undefined => {
      const match = existingTasks.find((t) => {
        const titleLower = t.title.toLowerCase();
        return keywords.some((k) => titleLower.includes(k.toLowerCase()));
      });
      return match?.taskId;
    };

    // ─── Capability 1: Project Architecture & Environment Setup ───────────────
    {
      const hasEntryPoints = project.entryPoints && project.entryPoints.length > 0;
      const hasDependencies = project.dependencies && project.dependencies.length > 0;
      const evidence: string[] = [];
      let status: GapStatus = 'unknown';
      let confidence = 0.5;

      if (hasEntryPoints && hasDependencies) {
        status = 'completed';
        confidence = 0.95;
        evidence.push(`Detected ${project.entryPoints.length} entry point(s): ${project.entryPoints.slice(0, 2).join(', ')}`);
        evidence.push(`Verified ${project.dependencies.length} package dependencies in ${project.frameworks.join(', ') || 'manifest'}`);
      } else if (hasEntryPoints || hasDependencies) {
        status = 'in_progress';
        confidence = 0.7;
        evidence.push(hasEntryPoints ? `Entry points identified (${project.entryPoints.join(', ')})` : 'Missing explicit entry point files');
      } else {
        status = 'missing';
        confidence = 0.9;
        evidence.push('No recognized package manifest or standard entry points found');
      }

      gaps.push({
        gapId: `gap-arch-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        category: 'architecture',
        title: 'Project Architecture & Environment Setup',
        description: 'Core project structure, entry points, and environment dependencies configuration.',
        status,
        evidence,
        confidence,
        relevantGraphNodeIds: graphNodes.filter((n) => n.kind === 'file' || n.kind === 'module').map((n) => n.id).slice(0, 3),
        suggestedTaskId: findMatchingTaskId(['architecture', 'entry points', 'structure', 'setup']),
        isCritical: true,
        createdAt: now,
        updatedAt: now
      });
    }

    // ─── Capability 2: Core Domain Implementation / Functions ─────────────────
    {
      const funcNodes = graphNodes.filter((n) => n.kind === 'function' || n.kind === 'class');
      const evidence: string[] = [];
      let status: GapStatus = 'unknown';
      let confidence = 0.6;

      if (funcNodes.length >= 5) {
        status = 'completed';
        confidence = 0.9;
        evidence.push(`Knowledge graph contains ${funcNodes.length} core functions/classes`);
        evidence.push(`Key symbols: ${funcNodes.slice(0, 3).map((n) => n.name).join(', ')}`);
      } else if (funcNodes.length > 0) {
        status = 'in_progress';
        confidence = 0.75;
        evidence.push(`Partial implementation detected (${funcNodes.length} symbols identified)`);
      } else {
        status = 'missing';
        confidence = 0.85;
        evidence.push('No functional code symbols or class definitions mapped in knowledge graph');
      }

      gaps.push({
        gapId: `gap-impl-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        category: 'implementation',
        title: 'Core Domain Implementation & Business Logic',
        description: 'Primary algorithmic handlers, service classes, and domain logic.',
        status,
        evidence,
        confidence,
        relevantGraphNodeIds: funcNodes.map((n) => n.id).slice(0, 5),
        suggestedTaskId: findMatchingTaskId(['core', 'feature', 'implement', 'service', 'handler']),
        isCritical: true,
        createdAt: now,
        updatedAt: now
      });
    }

    // ─── Capability 3: Automated Test Suites & Regression Coverage ───────────
    {
      const hasTestSuites = project.testSuites && project.testSuites.length > 0;
      const testNodes = graphNodes.filter((n) => n.kind === 'test_suite' || n.kind === 'test_case');
      const evidence: string[] = [];
      let status: GapStatus = 'unknown';
      let confidence = 0.5;

      if (hasTestSuites || testNodes.length > 0) {
        const testFrameworks = project.testSuites?.map((t) => t.framework).join(', ') || 'automated runner';
        status = 'completed';
        confidence = 0.95;
        evidence.push(`Configured test runner: ${testFrameworks}`);
        if (testNodes.length > 0) {
          evidence.push(`Mapped ${testNodes.length} test node(s) in knowledge graph`);
        }
      } else {
        status = 'missing';
        confidence = 0.9;
        evidence.push('No test suites, test cases, or test framework configurations detected');
      }

      gaps.push({
        gapId: `gap-test-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        category: 'testing',
        title: 'Automated Test Suites & QA Verification',
        description: 'Automated unit tests, regression suites, and verification rules.',
        status,
        evidence,
        confidence,
        relevantGraphNodeIds: testNodes.map((n) => n.id).slice(0, 3),
        suggestedTaskId: findMatchingTaskId(['test', 'qa', 'regression', 'suite', 'verify']),
        isCritical: true,
        createdAt: now,
        updatedAt: now
      });
    }

    // ─── Capability 4: Documentation & API Specifications ─────────────────────
    {
      const hasDocs = project.documentationFiles && project.documentationFiles.length > 0;
      const evidence: string[] = [];
      let status: GapStatus = 'unknown';
      let confidence = 0.6;

      if (hasDocs) {
        status = 'completed';
        confidence = 0.9;
        evidence.push(`Found ${project.documentationFiles.length} documentation file(s): ${project.documentationFiles.join(', ')}`);
      } else {
        status = 'missing';
        confidence = 0.85;
        evidence.push('No README, API specification, or architectural documentation files detected');
      }

      gaps.push({
        gapId: `gap-doc-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        category: 'documentation',
        title: 'Project Documentation & Specifications',
        description: 'Architecture overview, user guide, and interface documentation.',
        status,
        evidence,
        confidence,
        relevantGraphNodeIds: [],
        suggestedTaskId: findMatchingTaskId(['documentation', 'readme', 'spec', 'compliance']),
        isCritical: false,
        createdAt: now,
        updatedAt: now
      });
    }

    // ─── Capability 5: Domain-Specific Specialization Checks ──────────────────
    if (domainId === 'ai-ml') {
      // Data Pipeline & Preprocessing
      const dataNodes = graphNodes.filter((n) =>
        n.name.toLowerCase().includes('data') ||
        n.name.toLowerCase().includes('dataset') ||
        n.name.toLowerCase().includes('pipeline')
      );
      const evidence: string[] = [];
      let status: GapStatus = dataNodes.length > 0 ? 'completed' : 'missing';
      if (dataNodes.length > 0) {
        evidence.push(`Detected ${dataNodes.length} data pipeline / dataset component(s): ${dataNodes.slice(0, 2).map((n) => n.name).join(', ')}`);
      } else {
        evidence.push('No dataset loader or data preprocessing pipeline detected in graph');
      }

      gaps.push({
        gapId: `gap-ml-data-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        category: 'data_pipeline',
        title: 'Dataset Ingestion & Feature Preprocessing',
        description: 'Data ingestion, validation routines, and feature transformations.',
        status,
        evidence,
        confidence: 0.85,
        relevantGraphNodeIds: dataNodes.map((n) => n.id).slice(0, 3),
        suggestedTaskId: findMatchingTaskId(['dataset', 'eda', 'data', 'feature', 'preprocessing']),
        isCritical: true,
        createdAt: now,
        updatedAt: now
      });

      // Model Training & Checkpointing
      const modelNodes = graphNodes.filter((n) =>
        n.name.toLowerCase().includes('model') ||
        n.name.toLowerCase().includes('train') ||
        n.name.toLowerCase().includes('loss')
      );
      const modelEvidence: string[] = [];
      let modelStatus: GapStatus = modelNodes.length > 0 ? 'in_progress' : 'missing';
      if (modelNodes.length > 0) {
        modelEvidence.push(`Model training symbols detected: ${modelNodes.slice(0, 2).map((n) => n.name).join(', ')}`);
      } else {
        modelEvidence.push('No model training loop or neural architecture definitions identified');
      }

      gaps.push({
        gapId: `gap-ml-model-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        category: 'model',
        title: 'Model Training Loop & Optimization',
        description: 'Model definition, loss computation, and checkpoint persistence.',
        status: modelStatus,
        evidence: modelEvidence,
        confidence: 0.8,
        relevantGraphNodeIds: modelNodes.map((n) => n.id).slice(0, 3),
        suggestedTaskId: findMatchingTaskId(['train', 'model', 'gradient', 'loss']),
        isCritical: true,
        createdAt: now,
        updatedAt: now
      });
    } else if (domainId === 'cybersecurity') {
      // Security Vulnerability & Hardening Checks
      const authNodes = graphNodes.filter((n) =>
        n.name.toLowerCase().includes('auth') ||
        n.name.toLowerCase().includes('jwt') ||
        n.name.toLowerCase().includes('token') ||
        n.name.toLowerCase().includes('security')
      );
      const evidence: string[] = [];
      let status: GapStatus = authNodes.length > 0 ? 'completed' : 'missing';
      if (authNodes.length > 0) {
        evidence.push(`Found ${authNodes.length} authentication/security components: ${authNodes.slice(0, 2).map((n) => n.name).join(', ')}`);
      } else {
        evidence.push('No authentication token handling or cryptographic verification components identified');
      }

      gaps.push({
        gapId: `gap-sec-auth-${randomUUID().slice(0, 8)}`,
        projectId: project.id,
        category: 'security',
        title: 'Authentication & Cryptographic Hardening',
        description: 'Token validation, secret hygiene, and authorization boundaries.',
        status,
        evidence,
        confidence: 0.9,
        relevantGraphNodeIds: authNodes.map((n) => n.id).slice(0, 3),
        suggestedTaskId: findMatchingTaskId(['jwt', 'auth', 'harden', 'secret', 'sanitize']),
        isCritical: true,
        createdAt: now,
        updatedAt: now
      });
    }

    // ─── Calculate Completion Confidence Breakdown ───────────────────────────
    const confidenceBreakdown = ProjectGapAnalyzer.computeConfidenceBreakdown(gaps, project);
    const completionConfidence = ProjectGapAnalyzer.calculateCompletionConfidence(confidenceBreakdown);

    const summary = {
      completedCount: gaps.filter((g) => g.status === 'completed').length,
      inProgressCount: gaps.filter((g) => g.status === 'in_progress').length,
      missingCount: gaps.filter((g) => g.status === 'missing').length,
      blockedCount: gaps.filter((g) => g.status === 'blocked').length,
      unknownCount: gaps.filter((g) => g.status === 'unknown').length
    };

    return {
      projectId: project.id,
      projectName: project.name,
      domainId: project.domainId,
      gaps,
      completionConfidence,
      confidenceBreakdown,
      summary,
      analyzedAt: now
    };
  }

  /**
   * Reconcile an existing ProjectPlan with the latest Gap Analysis.
   * Preserves user-modified and completed tasks while inserting missing tasks
   * and updating blocked/ready statuses.
   */
  reconcilePlan(plan: ProjectPlan, gapResult: ProjectGapAnalysisResult): ProjectPlan {
    const existingTasks = [...plan.tasks];
    const taskMap = new Map<string, ProjectTask>();
    for (const t of existingTasks) {
      taskMap.set(t.taskId, t);
    }

    const now = Date.now();

    // 1. Reconcile verified capabilities with matching tasks
    for (const gap of gapResult.gaps) {
      if (gap.suggestedTaskId && taskMap.has(gap.suggestedTaskId)) {
        const task = taskMap.get(gap.suggestedTaskId)!;

        // If code evidence proves capability is completed and task was pending/ready, mark completed
        if (gap.status === 'completed' && (task.status === 'pending' || task.status === 'ready')) {
          task.status = 'completed';
          task.updatedAt = now;
        } else if (gap.status === 'blocked' && task.status !== 'completed') {
          task.status = 'blocked';
          task.updatedAt = now;
        }
      } else if (gap.status === 'missing') {
        // 2. Check if missing gap needs a new task created (prevent duplicates)
        const alreadyHasTask = existingTasks.some((t) =>
          t.title.toLowerCase().includes(gap.title.toLowerCase()) ||
          gap.title.toLowerCase().includes(t.title.toLowerCase())
        );

        if (!alreadyHasTask && plan.milestones.length > 0) {
          // Assign to the most relevant milestone or the last milestone
          const targetMilestone = plan.milestones[plan.milestones.length - 1];
          const newTaskId = `task-gap-${randomUUID().slice(0, 8)}`;

          const newTask: ProjectTask = {
            taskId: newTaskId,
            projectId: plan.projectId,
            milestoneId: targetMilestone.milestoneId,
            title: `Address Gap: ${gap.title}`,
            description: gap.description,
            status: 'pending',
            priority: gap.isCritical ? 'high' : 'medium',
            dependencies: targetMilestone.taskIds.length > 0 ? [targetMilestone.taskIds[targetMilestone.taskIds.length - 1]] : [],
            suggestedRoleId: 'sde-engineer',
            verificationRules: [],
            relevantGraphNodeIds: gap.relevantGraphNodeIds,
            createdAt: now,
            updatedAt: now
          };

          targetMilestone.taskIds.push(newTaskId);
          existingTasks.push(newTask);
          taskMap.set(newTaskId, newTask);
          gap.suggestedTaskId = newTaskId;
        }
      }
    }

    // 3. Recompute statuses & progress
    ProjectPlanner.recomputePlanStatuses(plan.milestones, existingTasks);
    const progress = ProjectPlanner.computeProgress(plan.milestones, existingTasks);

    plan.tasks = existingTasks;
    plan.progress = progress;
    plan.updatedAt = now;

    return plan;
  }

  /**
   * Compute evidence-based confidence factors.
   */
  static computeConfidenceBreakdown(gaps: ProjectGap[], project: Project): ConfidenceBreakdown {
    const totalGaps = gaps.length || 1;
    const completedGaps = gaps.filter((g) => g.status === 'completed').length;
    const inProgressGaps = gaps.filter((g) => g.status === 'in_progress').length;
    const missingCritical = gaps.filter((g) => g.status === 'missing' && g.isCritical).length;
    const blockedGaps = gaps.filter((g) => g.status === 'blocked').length;

    const implementationEvidenceScore = Math.round(((completedGaps + inProgressGaps * 0.5) / totalGaps) * 45);
    const testEvidenceScore = project.testSuites && project.testSuites.length > 0 ? 30 : 5;
    const documentationEvidenceScore = project.documentationFiles && project.documentationFiles.length > 0 ? 15 : 0;
    const criticalGapsPenalty = missingCritical * 15;
    const blockedPenalty = blockedGaps * 10;

    return {
      implementationEvidenceScore,
      testEvidenceScore,
      documentationEvidenceScore,
      criticalGapsPenalty,
      blockedPenalty
    };
  }

  /**
   * Calculate final Completion Confidence percentage (0 - 100).
   */
  static calculateCompletionConfidence(b: ConfidenceBreakdown): number {
    const raw =
      b.implementationEvidenceScore +
      b.testEvidenceScore +
      b.documentationEvidenceScore -
      b.criticalGapsPenalty -
      b.blockedPenalty;

    return Math.max(5, Math.min(95, Math.round(raw)));
  }
}
