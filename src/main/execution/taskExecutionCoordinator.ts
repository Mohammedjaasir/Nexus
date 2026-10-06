/**
 * Task execution planning (Phase 7C).
 *
 * Prepares the read-only plan: Task -> Role -> Context -> Model. It runs
 * nothing; the legacy shell verification runner was removed in B0a.
 */

import type { PersistStore } from '../db';
import type { ContextEngine } from '../context/contextEngine';
import type { TaskRouter } from '../routing/taskRouter';
import type { DomainAgentRole } from '../../shared/domain';
import { getDomainRole } from '../../shared/domain';
import type { AgentProvider } from '../../shared/agentProvider';
import type { TaskExecutionPlan } from '../../shared/execution';

export class TaskExecutionCoordinator {
  constructor(
    private store: PersistStore,
    private contextEngine: ContextEngine,
    private taskRouter: TaskRouter
  ) {}

  /**
   * Step 1-3: Prepare the structured execution plan with role routing and optimized context.
   */
  async prepareExecutionPlan(
    projectId: string,
    task: string,
    options: {
      roleId?: string;
      provider?: AgentProvider;
      model?: string;
      budgetTokens?: number;
    } = {}
  ): Promise<TaskExecutionPlan> {
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const graphNodes = this.store.getProjectGraphNodes(projectId);
    const routing = this.taskRouter.routeTask(task, project, graphNodes);

    // If user explicitly chose another role, use it; otherwise use recommended role
    let selectedRole: DomainAgentRole = routing.recommendedRole;
    if (options.roleId) {
      const explicitRole = getDomainRole(options.roleId);
      if (explicitRole) {
        selectedRole = explicitRole;
      }
    }

    const budget = options.budgetTokens || selectedRole.contextStrategy.defaultBudgetTokens || 32000;

    // Assemble optimized context package tailored for the role
    const contextPackage = await this.contextEngine.assembleContext(projectId, task, {
      budgetTokens: budget,
      agentRole: selectedRole.roleId,
      domainId: selectedRole.domainId
    });

    const selectedProvider: AgentProvider = options.provider || selectedRole.preferredProvider || 'claude';
    const selectedModel = options.model || selectedRole.preferredModel;

    // Build the complete injected execution prompt envelope
    const assembledPrompt = [
      `# ROLE SPECIFICATION: ${selectedRole.title.toUpperCase()}`,
      selectedRole.contextStrategy.systemPromptPreamble,
      '',
      `# TASK INSTRUCTIONS`,
      task.trim(),
      '',
      contextPackage.assembledText
    ].join('\n');

    return {
      projectId,
      task,
      role: selectedRole,
      routing,
      contextPackage,
      selectedProvider,
      selectedModel,
      assembledPrompt,
      verificationRuleIds: selectedRole.verificationRules || []
    };
  }
}
