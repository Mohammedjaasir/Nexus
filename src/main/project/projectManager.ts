/**
 * ProjectManager — coordinates project lifecycle, storage, and analysis.
 *
 * Runs in Electron Main, manages projects stored in PersistStore SQLite database.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PersistStore } from '../db';
import { analyzeProject } from './projectAnalyzer';
import { extractProjectKnowledgeGraph } from './projectGraphExtractor';
import { ContextEngine } from '../context/contextEngine';
import type {
  CreateProjectInput,
  Project,
  ProjectScanResult,
  UpdateProjectInput
} from '../../shared/project';
import type {
  ContextPackage,
  ContextBenchmarkResult,
  ContextAssemblyOptions
} from '../../shared/context';
import type {
  ProjectGraphNode,
  ProjectGraphEdge,
  ProjectGraphStats,
  ProjectSubgraph,
  ProjectGraphQueryFilter,
  ProjectGraphRelationKind
} from '../../shared/graph';
import {
  type DomainId,
  type DomainAgentRole,
  getRolesForDomain,
  suggestRoleForTask
} from '../../shared/domain';
import { TaskRouter } from '../routing/taskRouter';
import { TaskExecutionCoordinator } from '../execution/taskExecutionCoordinator';
import { ProjectPlanner } from '../plan/projectPlanner';
import { ProjectGapAnalyzer } from '../plan/projectGapAnalyzer';
import { GoalPlanner } from '../plan/goalPlanner';
import { ProjectCompletionController } from '../plan/projectCompletionController';
import type { TaskRoutingResult } from '../../shared/routing';
import type {
  TaskExecutionPlan,
  TaskExecutionResult,
  TaskVerificationSummary
} from '../../shared/execution';
import type { ProjectPlan, TaskStatus } from '../../shared/plan';
import type { ProjectGapAnalysisResult } from '../../shared/gap';
import type { ProjectGoal, GoalAnalysisResult } from '../../shared/goal';
import type {
  NextTaskResult,
  ProjectStepResult,
  ProjectCompletionContract
} from '../../shared/completion';
import type { AgentProvider } from '../../shared/agentProvider';

export class ProjectManager {
  private contextEngine: ContextEngine;
  private taskRouter: TaskRouter;
  private executionCoordinator: TaskExecutionCoordinator;
  private planner: ProjectPlanner;
  private gapAnalyzer: ProjectGapAnalyzer;
  private goalPlanner: GoalPlanner;
  private completionController: ProjectCompletionController;

  constructor(private store: PersistStore) {
    this.contextEngine = new ContextEngine(store);
    this.taskRouter = new TaskRouter();
    this.executionCoordinator = new TaskExecutionCoordinator(
      store,
      this.contextEngine,
      this.taskRouter
    );
    this.planner = new ProjectPlanner(this.taskRouter);
    this.gapAnalyzer = new ProjectGapAnalyzer();
    this.goalPlanner = new GoalPlanner();
    this.completionController = new ProjectCompletionController(
      store,
      this.executionCoordinator,
      this.gapAnalyzer,
      this.goalPlanner
    );
  }

  /**
   * Scan a local folder without creating a project.
   */
  async scan(rootPath: string): Promise<ProjectScanResult> {
    return analyzeProject(rootPath);
  }

  /**
   * Create a new project explicitly.
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const root = resolve(input.rootPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`Invalid project directory: ${root}`);
    }

    // Run deterministic analysis to populate project metadata
    const scanResult = await analyzeProject(root);
    const now = Date.now();

    const project: Project = {
      id: `proj_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: input.name.trim() || scanResult.suggestedName,
      rootPath: root,
      domainId: input.domainId || scanResult.suggestedDomainId,
      secondaryDomains: input.secondaryDomains || scanResult.secondaryDomains,
      description: input.description,
      projectType: input.projectType || scanResult.projectType,
      detectedLanguages: scanResult.languages,
      frameworks: scanResult.frameworks,
      dependencies: scanResult.dependencies,
      entryPoints: scanResult.entryPoints,
      importantFiles: scanResult.importantFiles,
      testSuites: scanResult.testSuites,
      documentationFiles: scanResult.documentationFiles,
      gitInfo: scanResult.gitInfo,
      health: scanResult.health,
      lastAnalyzedAt: now,
      createdAt: now,
      updatedAt: now
    };

    this.store.saveProject(project);

    // Extract and persist initial Project Knowledge Graph
    try {
      const graph = extractProjectKnowledgeGraph(project.id, project.rootPath, project.name);
      this.store.saveProjectGraph(project.id, graph.nodes, graph.edges);
    } catch {
      // best-effort
    }

    // Generate and persist initial Project Plan
    try {
      const graphNodes = this.store.getProjectGraphNodes(project.id);
      const plan = this.planner.generateInitialPlan(project, graphNodes);
      this.store.saveProjectPlan(plan);
    } catch {
      // best-effort
    }

    // If no active project exists, set this as active
    if (!this.store.getActiveProjectId()) {
      this.store.setActiveProjectId(project.id);
    }

    return project;
  }

  /**
   * Import an existing project directory.
   */
  async importProject(
    rootPath: string,
    domainId?: DomainId,
    name?: string
  ): Promise<{ project: Project; scanResult: ProjectScanResult }> {
    const root = resolve(rootPath);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error(`Directory not found: ${root}`);
    }

    const scanResult = await analyzeProject(root);

    // Check if a project with this rootPath already exists
    const existing = this.store.listProjects().find((p) => resolve(p.rootPath) === root);
    const now = Date.now();

    if (existing) {
      const updated: Project = {
        ...existing,
        name: name?.trim() || existing.name,
        domainId: domainId || existing.domainId,
        secondaryDomains: scanResult.secondaryDomains,
        projectType: scanResult.projectType,
        detectedLanguages: scanResult.languages,
        frameworks: scanResult.frameworks,
        dependencies: scanResult.dependencies,
        entryPoints: scanResult.entryPoints,
        importantFiles: scanResult.importantFiles,
        testSuites: scanResult.testSuites,
        documentationFiles: scanResult.documentationFiles,
        gitInfo: scanResult.gitInfo,
        health: scanResult.health,
        lastAnalyzedAt: now,
        updatedAt: now
      };
      this.store.saveProject(updated);
      this.store.setActiveProjectId(updated.id);

      try {
        const graph = extractProjectKnowledgeGraph(updated.id, updated.rootPath, updated.name);
        this.store.saveProjectGraph(updated.id, graph.nodes, graph.edges);
      } catch {
        // best-effort
      }

      return { project: updated, scanResult };
    }

    const project: Project = {
      id: `proj_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: name?.trim() || scanResult.suggestedName,
      rootPath: root,
      domainId: domainId || scanResult.suggestedDomainId,
      secondaryDomains: scanResult.secondaryDomains,
      projectType: scanResult.projectType,
      detectedLanguages: scanResult.languages,
      frameworks: scanResult.frameworks,
      dependencies: scanResult.dependencies,
      entryPoints: scanResult.entryPoints,
      importantFiles: scanResult.importantFiles,
      testSuites: scanResult.testSuites,
      documentationFiles: scanResult.documentationFiles,
      gitInfo: scanResult.gitInfo,
      health: scanResult.health,
      lastAnalyzedAt: now,
      createdAt: now,
      updatedAt: now
    };

    this.store.saveProject(project);
    this.store.setActiveProjectId(project.id);

    try {
      const graph = extractProjectKnowledgeGraph(project.id, project.rootPath, project.name);
      this.store.saveProjectGraph(project.id, graph.nodes, graph.edges);
    } catch {
      // best-effort
    }

    return { project, scanResult };
  }

  /**
   * Re-analyze an existing project to refresh its metadata, health metrics, and knowledge graph.
   */
  async refreshProject(projectId: string): Promise<Project | null> {
    const existing = this.store.getProject(projectId);
    if (!existing || !existsSync(existing.rootPath)) return null;

    const scanResult = await analyzeProject(existing.rootPath);
    const now = Date.now();

    const updated: Project = {
      ...existing,
      secondaryDomains: scanResult.secondaryDomains,
      projectType: scanResult.projectType,
      detectedLanguages: scanResult.languages,
      frameworks: scanResult.frameworks,
      dependencies: scanResult.dependencies,
      entryPoints: scanResult.entryPoints,
      importantFiles: scanResult.importantFiles,
      testSuites: scanResult.testSuites,
      documentationFiles: scanResult.documentationFiles,
      gitInfo: scanResult.gitInfo,
      health: scanResult.health,
      lastAnalyzedAt: now,
      updatedAt: now
    };

    this.store.saveProject(updated);

    try {
      const graph = extractProjectKnowledgeGraph(updated.id, updated.rootPath, updated.name);
      this.store.saveProjectGraph(updated.id, graph.nodes, graph.edges);
    } catch {
      // best-effort
    }

    return updated;
  }

  /**
   * Get a project by ID.
   */
  getProject(id: string): Project | null {
    return this.store.getProject(id);
  }

  /**
   * List all projects.
   */
  listProjects(): Project[] {
    return this.store.listProjects();
  }

  /**
   * Update a project's details.
   */
  updateProject(id: string, input: UpdateProjectInput): Project | null {
    return this.store.updateProject(id, input);
  }

  /**
   * Delete a project and its associated knowledge graph.
   */
  deleteProject(id: string): boolean {
    this.store.deleteProjectGraph(id);
    return this.store.deleteProject(id);
  }

  /**
   * Get the active project.
   */
  getActiveProject(): Project | null {
    const activeId = this.store.getActiveProjectId();
    if (!activeId) return null;
    return this.store.getProject(activeId);
  }

  /**
   * Set the active project by ID.
   */
  setActiveProject(id: string | null): Project | null {
    if (!id) {
      this.store.setActiveProjectId(null);
      return null;
    }
    const project = this.store.getProject(id);
    if (project) {
      this.store.setActiveProjectId(id);
      return project;
    }
    return null;
  }

  // ─── Project Knowledge Graph Query APIs ───────────────────────────────────

  /** Get high-level statistics for a project's knowledge graph. */
  getGraphStats(projectId: string): ProjectGraphStats {
    return this.store.getProjectGraphStats(projectId);
  }

  /** Get nodes in a project's knowledge graph with optional filter. */
  getGraphNodes(projectId: string, filter?: ProjectGraphQueryFilter): ProjectGraphNode[] {
    return this.store.getProjectGraphNodes(projectId, filter);
  }

  /** Get a single node by ID. */
  getGraphNode(projectId: string, nodeId: string): ProjectGraphNode | null {
    return this.store.getProjectGraphNode(projectId, nodeId);
  }

  /** Get direct neighbors and edges connected to a node. */
  getGraphNeighbors(
    projectId: string,
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both'
  ): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] } {
    return this.store.getProjectGraphNeighbors(projectId, nodeId, direction);
  }

  /** Find a node by path or name substring. */
  findGraphNode(projectId: string, query: string): ProjectGraphNode[] {
    return this.store.getProjectGraphNodes(projectId, { name: query });
  }

  /** Find related nodes connected by a specific relation kind. */
  findRelatedGraphNodes(
    projectId: string,
    nodeId: string,
    relationKind: ProjectGraphRelationKind
  ): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] } {
    const edges = this.store.getProjectGraphEdges(projectId, { sourceId: nodeId, kind: relationKind });
    const targetIds = edges.map((e) => e.target);
    const nodes = targetIds
      .map((id) => this.store.getProjectGraphNode(projectId, id))
      .filter((n): n is ProjectGraphNode => n !== null);
    return { nodes, edges };
  }

  /** Get an N-depth subgraph around a root node. */
  getGraphSubgraph(projectId: string, nodeId: string, depth = 1): ProjectSubgraph {
    return this.store.getProjectSubgraph(projectId, nodeId, depth);
  }

  /** Force rebuild the knowledge graph for a project from disk. */
  rebuildGraph(projectId: string): ProjectGraphStats | null {
    const project = this.store.getProject(projectId);
    if (!project || !existsSync(project.rootPath)) return null;

    const graph = extractProjectKnowledgeGraph(project.id, project.rootPath, project.name);
    this.store.saveProjectGraph(project.id, graph.nodes, graph.edges);
    return this.store.getProjectGraphStats(projectId);
  }

  /**
   * Assemble optimized, tiered context for an agent working on a specific task.
   */
  async assembleContext(
    projectId: string,
    task: string,
    options?: ContextAssemblyOptions
  ): Promise<ContextPackage> {
    return this.contextEngine.assembleContext(projectId, task, options);
  }

  /**
   * Prepare an enriched agent prompt package injecting minimum sufficient context for a task.
   */
  async prepareAgentTaskContext(
    projectId: string,
    task: string,
    options?: ContextAssemblyOptions
  ): Promise<{ task: string; contextPackage: ContextPackage; enrichedPrompt: string }> {
    const contextPackage = await this.contextEngine.assembleContext(projectId, task, options);
    const enrichedPrompt = [
      `# TASK INSTRUCTIONS`,
      task.trim(),
      '',
      contextPackage.assembledText
    ].join('\n');

    return {
      task,
      contextPackage,
      enrichedPrompt
    };
  }

  /**
   * Run benchmark comparing baseline vs graph-optimized context for a task.
   */
  async runContextBenchmark(
    projectId: string,
    task: string,
    budgetTokens?: number
  ): Promise<ContextBenchmarkResult> {
    return this.contextEngine.runBenchmark(projectId, task, budgetTokens);
  }

  // ─── Domain Agent Profile APIs ────────────────────────────────────────────

  /**
   * Get all specialized agent roles available for a project's domain.
   */
  getRolesForProject(projectId: string): DomainAgentRole[] {
    const project = this.store.getProject(projectId);
    if (!project) return [];
    return getRolesForDomain(project.domainId);
  }

  /**
   * Suggest the best-suited specialized agent role for a task within a project's domain.
   */
  suggestRoleForProjectTask(projectId: string, task: string): DomainAgentRole | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;
    return suggestRoleForTask(task, project.domainId as DomainId);
  }

  /**
   * Deterministically route a task to the optimal specialized agent role with full explainability.
   */
  routeTask(projectId: string, task: string): TaskRoutingResult | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;
    const graphNodes = this.store.getProjectGraphNodes(projectId);
    return this.taskRouter.routeTask(task, project, graphNodes);
  }

  // ─── Phase 7C: End-to-End Execution & Verification APIs ───────────────────

  /**
   * Prepare complete task execution plan (Task -> Role -> Context -> Model).
   */
  async prepareTaskExecutionPlan(
    projectId: string,
    task: string,
    options?: {
      roleId?: string;
      provider?: AgentProvider;
      model?: string;
      budgetTokens?: number;
    }
  ): Promise<TaskExecutionPlan> {
    return this.executionCoordinator.prepareExecutionPlan(projectId, task, options);
  }

  /**
   * Run verification rules on project workspace.
   */
  async runTaskVerification(
    projectId: string,
    ruleIds?: string[],
    customVerificationCommand?: string
  ): Promise<TaskVerificationSummary> {
    return this.executionCoordinator.runVerification(projectId, ruleIds, customVerificationCommand);
  }

  /**
   * Execute task plan end-to-end and run automated verification.
   */
  async executeTaskPlan(
    plan: TaskExecutionPlan,
    agentActionRunner?: () => Promise<string[]>,
    customVerificationCommand?: string
  ): Promise<TaskExecutionResult> {
    return this.executionCoordinator.executePlan(plan, agentActionRunner, customVerificationCommand);
  }

  // ─── Phase 8A: Project Plan & Task Graph APIs ─────────────────────────────

  /**
   * Get the persisted milestone and task graph plan for a project.
   */
  getProjectPlan(projectId: string): ProjectPlan | null {
    let plan = this.store.getProjectPlan(projectId);
    if (!plan) {
      const project = this.store.getProject(projectId);
      if (project) {
        const graphNodes = this.store.getProjectGraphNodes(projectId);
        plan = this.planner.generateInitialPlan(project, graphNodes);
        this.store.saveProjectPlan(plan);
      }
    }
    return plan;
  }

  /**
   * Regenerate and persist a fresh milestone and task graph plan for a project.
   */
  generateProjectPlan(projectId: string): ProjectPlan | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;
    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const plan = this.planner.generateInitialPlan(project, graphNodes);
    this.store.saveProjectPlan(plan);
    return plan;
  }

  /**
   * Update the status of a specific task in the project plan, recomputing DAG dependencies and progress.
   */
  updateTaskStatus(projectId: string, taskId: string, status: TaskStatus): ProjectPlan | null {
    const plan = this.getProjectPlan(projectId);
    if (!plan) return null;

    const task = plan.tasks.find((t) => t.taskId === taskId);
    if (!task) return null;

    task.status = status;
    task.updatedAt = Date.now();

    // Recompute DAG dependencies and milestone progress
    ProjectPlanner.recomputePlanStatuses(plan.milestones, plan.tasks);
    plan.progress = ProjectPlanner.computeProgress(plan.milestones, plan.tasks);
    plan.updatedAt = Date.now();

    this.store.saveProjectPlan(plan);
    return plan;
  }

  // ─── Phase 8B: Project Gap Analysis & State-Aware Reconciliation ──────────

  /**
   * Analyze project capabilities, missing areas, and evidence-based completion confidence.
   */
  analyzeProjectGaps(projectId: string): ProjectGapAnalysisResult | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const graphEdges = this.store.getProjectGraphEdges(projectId);
    const existingPlan = this.store.getProjectPlan(projectId);

    const result = this.gapAnalyzer.analyzeGaps(project, graphNodes, graphEdges, existingPlan);
    this.store.saveProjectGapAnalysis(result);
    return result;
  }

  /**
   * Reconcile existing ProjectPlan with real project gap evidence without overwriting completed work.
   */
  reconcileProjectPlan(projectId: string): { plan: ProjectPlan; gaps: ProjectGapAnalysisResult } | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    const plan = this.getProjectPlan(projectId);
    if (!plan) return null;

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const graphEdges = this.store.getProjectGraphEdges(projectId);
    const gapResult = this.gapAnalyzer.analyzeGaps(project, graphNodes, graphEdges, plan);

    const reconciledPlan = this.gapAnalyzer.reconcilePlan(plan, gapResult);
    this.store.saveProjectPlan(reconciledPlan);
    this.store.saveProjectGapAnalysis(gapResult);

    return {
      plan: reconciledPlan,
      gaps: gapResult
    };
  }

  // ─── Phase 8C: Goal-Aware Project Planning ────────────────────────────────

  /**
   * Define or update the project's explicit high-level goal and evaluate capabilities.
   */
  setProjectGoal(projectId: string, title: string, description?: string): GoalAnalysisResult | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    const goal = this.goalPlanner.createProjectGoal(projectId, title, description, project.domainId);
    this.store.saveProjectGoal(goal);

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const graphEdges = this.store.getProjectGraphEdges(projectId);
    const existingPlan = this.store.getProjectPlan(projectId);

    return this.goalPlanner.evaluateGoal(goal, project, graphNodes, graphEdges, existingPlan);
  }

  /**
   * Retrieve and evaluate the active project goal against latest project evidence.
   */
  getProjectGoal(projectId: string): GoalAnalysisResult | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    const goal = this.store.getProjectGoal(projectId);
    if (!goal) return null;

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const graphEdges = this.store.getProjectGraphEdges(projectId);
    const existingPlan = this.store.getProjectPlan(projectId);

    return this.goalPlanner.evaluateGoal(goal, project, graphNodes, graphEdges, existingPlan);
  }

  /**
   * Reconcile ProjectPlan against active goal capabilities, creating tasks only for missing work.
   */
  reconcileGoalPlan(projectId: string): { plan: ProjectPlan; goalAnalysis: GoalAnalysisResult } | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    const goal = this.store.getProjectGoal(projectId);
    if (!goal) return null;

    const plan = this.getProjectPlan(projectId);
    if (!plan) return null;

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const graphEdges = this.store.getProjectGraphEdges(projectId);

    const goalAnalysis = this.goalPlanner.evaluateGoal(goal, project, graphNodes, graphEdges, plan);
    const reconciledPlan = this.goalPlanner.reconcileGoalPlan(
      goal,
      goalAnalysis.evaluatedCapabilities,
      plan,
      project
    );

    this.store.saveProjectPlan(reconciledPlan);
    return {
      plan: reconciledPlan,
      goalAnalysis
    };
  }

  // ─── Phase 9: Complete Project — Verified Execution ───────────────────────

  /**
   * Find and prepare the next ready task in the project pipeline.
   */
  async getNextProjectTask(projectId: string): Promise<NextTaskResult | null> {
    return this.completionController.getNextTask(projectId);
  }

  /**
   * Execute one controlled step in the project completion workflow.
   */
  async executeProjectStep(
    projectId: string,
    agentActionRunner?: () => Promise<string[]>,
    customVerificationCommand?: string
  ): Promise<ProjectStepResult | null> {
    return this.completionController.executeStep(projectId, agentActionRunner, customVerificationCommand);
  }

  /**
   * Evaluate whether project goal meets the complete verification contract.
   */
  evaluateProjectCompletionContract(projectId: string): ProjectCompletionContract | null {
    const project = this.store.getProject(projectId);
    if (!project) return null;

    const plan = this.getProjectPlan(projectId);
    if (!plan) return null;

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const graphEdges = this.store.getProjectGraphEdges(projectId);

    const goal = this.store.getProjectGoal(projectId);
    const goalAnalysis = goal
      ? this.goalPlanner.evaluateGoal(goal, project, graphNodes, graphEdges, plan)
      : null;

    const gapAnalysis = this.gapAnalyzer.analyzeGaps(project, graphNodes, graphEdges, plan);
    return this.completionController.evaluateCompletionContract(project, goalAnalysis, gapAnalysis, plan, true);
  }
}
