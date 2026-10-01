/**
 * Task Execution and Verification Coordinator (Phase 7C).
 *
 * Coordinates the deterministic end-to-end pipeline:
 * Task -> Role -> Context -> Model -> Agent Runtime -> Verification -> Result.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { PersistStore } from '../db';
import type { ContextEngine } from '../context/contextEngine';
import type { TaskRouter } from '../routing/taskRouter';
import type { DomainAgentRole, DomainId } from '../../shared/domain';
import { getDomainRole, getDomainDefinition } from '../../shared/domain';
import type { AgentProvider } from '../../shared/agentProvider';
import type {
  TaskExecutionPlan,
  TaskExecutionResult,
  TaskVerificationSummary,
  TaskVerificationRuleResult,
  TaskVerificationStatus
} from '../../shared/execution';

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

  /**
   * Run the role's verification rules on the project workspace.
   */
  async runVerification(
    projectId: string,
    ruleIds: string[] = [],
    customVerificationCommand?: string
  ): Promise<TaskVerificationSummary> {
    const project = this.store.getProject(projectId);
    if (!project) {
      return {
        status: 'needs_review',
        summary: 'Project not found for verification',
        rules: [],
        testsExecuted: 0,
        testsPassed: 0,
        testsFailed: 0
      };
    }

    const rootPath = project.rootPath;
    const ruleResults: TaskVerificationRuleResult[] = [];
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    // 1. If a custom test command or test suite was identified, run it
    const commandsToRun: Array<{ id: string; name: string; cmd: string }> = [];

    if (customVerificationCommand) {
      commandsToRun.push({
        id: 'custom-verification',
        name: 'Custom Verification Runner',
        cmd: customVerificationCommand
      });
    } else {
      // Determine commands based on project metadata and verification rules
      if (project.testSuites && project.testSuites.length > 0) {
        const ts = project.testSuites[0];
        if (ts.testCommand) {
          commandsToRun.push({
            id: 'project-test-suite',
            name: `${ts.framework} Test Suite`,
            cmd: ts.testCommand
          });
        } else if (ts.framework === 'node:test' || ts.framework === 'jest' || ts.framework === 'vitest') {
          commandsToRun.push({
            id: 'node-test',
            name: 'Node Test Runner',
            cmd: 'npm test --if-present'
          });
        } else if (ts.framework === 'pytest') {
          commandsToRun.push({
            id: 'pytest',
            name: 'PyTest Suite',
            cmd: 'pytest'
          });
        }
      }

      // Check for typecheck rule
      if (ruleIds.includes('rule-typecheck') && existsSync(`${rootPath}/tsconfig.json`)) {
        commandsToRun.push({
          id: 'rule-typecheck',
          name: 'TypeScript Compilation Check',
          cmd: 'npm run typecheck --if-present'
        });
      }
    }

    if (commandsToRun.length === 0) {
      return {
        status: 'needs_review',
        summary: 'No automated verification rules could be executed for this workspace.',
        rules: [],
        testsExecuted: 0,
        testsPassed: 0,
        testsFailed: 0
      };
    }

    let allPassed = true;

    for (const rule of commandsToRun) {
      let exitCode = 0;
      let output = '';
      let passed = true;

      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;

      try {
        output = execSync(rule.cmd, {
          cwd: rootPath,
          encoding: 'utf8',
          timeout: 45000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv
        });
      } catch (err: unknown) {
        const execErr = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        exitCode = typeof execErr.status === 'number' ? execErr.status : 1;
        const errStdout = execErr.stdout ? (Buffer.isBuffer(execErr.stdout) ? execErr.stdout.toString('utf8') : String(execErr.stdout)) : '';
        const errStderr = execErr.stderr ? (Buffer.isBuffer(execErr.stderr) ? execErr.stderr.toString('utf8') : String(execErr.stderr)) : '';
        output = (errStdout + '\n' + errStderr + '\n' + (execErr.message || '')).trim();
        passed = false;
        allPassed = false;
      }

      // Parse TAP / Test output counts
      const passMatch = output.match(/#\s*pass\s+(\d+)/i);
      const failMatch = output.match(/#\s*fail\s+(\d+)/i);
      const tapPassMatches = output.match(/(?:^|\r?\n)\s*ok\s+\d+/g);
      const tapFailMatches = output.match(/(?:^|\r?\n)\s*not ok\s+\d+/g);

      if (passMatch || failMatch) {
        const p = passMatch ? parseInt(passMatch[1], 10) : 0;
        const f = failMatch ? parseInt(failMatch[1], 10) : 0;
        totalTests += p + f;
        passedTests += p;
        failedTests += f;
        if (f > 0 || exitCode !== 0) {
          passed = false;
          allPassed = false;
        }
      } else if (tapPassMatches || tapFailMatches) {
        const p = tapPassMatches ? tapPassMatches.length : 0;
        const f = tapFailMatches ? tapFailMatches.length : 0;
        totalTests += p + f;
        passedTests += p;
        failedTests += f;
        if (f > 0 || exitCode !== 0) {
          passed = false;
          allPassed = false;
        }
      } else if (passed && exitCode === 0) {
        totalTests += 1;
        passedTests += 1;
      } else {
        totalTests += 1;
        failedTests += 1;
        passed = false;
        allPassed = false;
      }

      ruleResults.push({
        ruleId: rule.id,
        ruleName: rule.name,
        command: rule.cmd,
        exitCode,
        output: output.slice(0, 2000),
        passed
      });
    }

    const status: TaskVerificationStatus = (allPassed && failedTests === 0) ? 'success' : 'failed';
    const summary = status === 'success'
      ? `Verification passed: ${passedTests}/${totalTests} checks succeeded across ${ruleResults.length} rule(s).`
      : `Verification failed: ${failedTests} failure(s) or non-zero exit code detected during verification execution.`;

    return {
      status,
      summary,
      rules: ruleResults,
      testsExecuted: totalTests,
      testsPassed: passedTests,
      testsFailed: failedTests
    };
  }

  /**
   * End-to-end task execution wrapper.
   */
  async executePlan(
    plan: TaskExecutionPlan,
    agentActionRunner?: () => Promise<string[]>,
    customVerificationCommand?: string
  ): Promise<TaskExecutionResult> {
    const t0 = performance.now();
    const project = this.store.getProject(plan.projectId);
    const projectName = project?.name || plan.projectId;

    let changedFiles: string[] = [];

    // Execute agent action if provided
    if (agentActionRunner) {
      changedFiles = await agentActionRunner();
    }

    // Run verification
    const verification = await this.runVerification(
      plan.projectId,
      plan.verificationRuleIds,
      customVerificationCommand
    );

    const t1 = performance.now();

    return {
      taskId: randomUUID(),
      projectId: plan.projectId,
      projectName,
      task: plan.task,
      role: plan.role,
      provider: plan.selectedProvider,
      model: plan.selectedModel,
      contextTokens: plan.contextPackage.estimatedTokens,
      contextReductionPercentage: plan.contextPackage.reductionPercentage,
      changedFiles,
      verification,
      executionLatencyMs: Math.round(t1 - t0),
      completedAt: Date.now()
    };
  }
}
