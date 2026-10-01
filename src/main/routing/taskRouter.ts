/**
 * Deterministic Task -> Agent Router for Munder Difflin.
 *
 * Evaluates task intent, primary and secondary project domains, project type,
 * knowledge graph evidence, and role capabilities to recommend the optimal
 * specialized agent role with full explainability.
 */

import type { Project } from '../../shared/project';
import type { ProjectGraphNode } from '../../shared/graph';
import type { DomainId, DomainAgentRole } from '../../shared/domain';
import { getDomainDefinition, getRolesForDomain } from '../../shared/domain';
import type { TaskRoutingResult, AgentRoleCandidate, PreparedAgentConfig } from '../../shared/routing';

const ROLE_KEYWORD_PATTERNS: Record<string, string[]> = {
  'sde-planner': ['plan', 'break', 'architect', 'roadmap', 'design', 'spec', 'dag', 'decompose', 'structure'],
  'sde-engineer': ['implement', 'feature', 'build', 'add', 'create', 'code', 'endpoint', 'refactor', 'develop'],
  'sde-debugger': ['fix', 'debug', 'bug', 'error', 'fail', 'crash', 'stack trace', 'exception', 'null', 'patch', 'issue'],
  'sde-tester': ['test', 'qa', 'coverage', 'assert', 'unit test', 'integration', 'e2e', 'regression', 'verify', 'spec'],
  'sde-reviewer': ['review', 'pr', 'clean', 'style', 'hygiene', 'audit code', 'lint', 'standards'],
  'aiml-engineer': ['train', 'model', 'pipeline', 'inference', 'weights', 'tensor', 'gpu', 'batch', 'cuda', 'onnx', 'serving'],
  'aiml-data-scientist': ['eda', 'dataset', 'feature', 'pandas', 'dataframe', 'stats', 'distribution', 'explore', 'cleaning'],
  'aiml-researcher': ['research', 'paper', 'ablation', 'hyperparameter', 'hypothesis', 'experiment', 'literature'],
  'aiml-debugger': ['gradient', 'nan', 'explosion', 'loss', 'divergence', 'underflow', 'broadcast', 'shape mismatch'],
  'aiml-evaluator': ['eval', 'benchmark', 'f1', 'bleu', 'accuracy', 'precision', 'drift', 'metric', 'recall', 'perplexity'],
  'sec-analyst': ['security', 'vulnerability', 'cve', 'secret', 'leak', 'scan', 'sast', 'audit', 'owasp', 'exposure'],
  'sec-coder': ['harden', 'auth', 'jwt', 'token', 'sanitize', 'crypto', 'permission', 'cors', 'xss', 'csrf', 'injection', 'password'],
  'sec-researcher': ['exploit', 'threat', 'intel', 'advisory', 'cve-', 'zero-day', 'attack vector'],
  'sec-tester': ['fuzz', 'penetration', 'pentest', 'boundary', 'payload', 'dast', 'injection test', 'bypass'],
  'sec-doc': ['compliance', 'soc2', 'iso', 'playbook', 'security doc', 'incident report', 'remediation guide']
};

export class TaskRouter {
  /**
   * Deterministically route a task to the best specialized agent role.
   */
  routeTask(
    task: string,
    project: Project,
    graphNodes: ProjectGraphNode[] = []
  ): TaskRoutingResult {
    const taskNormalized = task.toLowerCase();
    const taskTokens = (taskNormalized.match(/[a-z0-9_.-]+/g) || []).filter((w) => w.length > 2);

    // 1. Gather Candidate Roles from Primary and Secondary Domains
    const candidateDomains: DomainId[] = [project.domainId as DomainId];
    if (project.secondaryDomains) {
      for (const sec of project.secondaryDomains) {
        if (!candidateDomains.includes(sec as DomainId)) {
          candidateDomains.push(sec as DomainId);
        }
      }
    }

    const candidateRoles: DomainAgentRole[] = [];
    for (const dId of candidateDomains) {
      candidateRoles.push(...getRolesForDomain(dId));
    }

    // 2. Score Candidates
    const scoredCandidates: AgentRoleCandidate[] = [];

    for (const role of candidateRoles) {
      let score = 0;
      const reasons: string[] = [];
      const isPrimaryDomain = role.domainId === project.domainId;

      // Signal A: Domain Base Affinity
      if (isPrimaryDomain) {
        score += 25;
        reasons.push(`Primary domain: ${getDomainDefinition(role.domainId).name}`);
      } else {
        score += 10;
        reasons.push(`Secondary domain: ${getDomainDefinition(role.domainId).name}`);
      }

      // Signal B: Keyword Pattern Matching
      const patterns = ROLE_KEYWORD_PATTERNS[role.roleId] || [];
      let matchedPatterns = 0;
      for (const p of patterns) {
        if (taskNormalized.includes(p)) {
          matchedPatterns++;
        }
      }
      if (matchedPatterns > 0) {
        const patternBoost = matchedPatterns * 30;
        score += patternBoost;
        reasons.push(`Task text contains ${matchedPatterns} strong role signal(s)`);
      }

      // Signal C: Explicit Capability Matching
      for (const cap of role.capabilities) {
        const capWords = cap.replace(/-/g, ' ').toLowerCase();
        if (taskNormalized.includes(capWords)) {
          score += 35;
          reasons.push(`Role capability directly matches task: "${cap}"`);
        } else {
          // Sub-word match
          const subWords = cap.split('-');
          for (const sw of subWords) {
            if (sw.length > 3 && taskTokens.includes(sw)) {
              score += 15;
              reasons.push(`Role capability alignment: "${cap}"`);
              break;
            }
          }
        }
      }

      // Signal D: Project Type Affinity
      if (project.projectType === 'notebook_pipeline' && role.domainId === 'ai-ml') {
        score += 20;
        reasons.push('Project type is a notebook pipeline (AI/ML specialization boost)');
      } else if (project.projectType === 'service' && (role.roleId === 'sde-engineer' || role.roleId === 'sec-coder')) {
        score += 15;
        reasons.push('Project type is a backend service / API');
      } else if (project.projectType === 'library' && (role.roleId === 'sde-engineer' || role.roleId === 'sde-tester')) {
        score += 15;
        reasons.push('Project type is a reusable software library');
      }

      // Signal E: Knowledge Graph Evidence
      if (graphNodes && graphNodes.length > 0) {
        const graphMatches = findGraphEvidenceForRole(role, graphNodes);
        if (graphMatches.length > 0) {
          score += 25;
          reasons.push(`Knowledge graph contains matching components: ${graphMatches.slice(0, 3).join(', ')}`);
        }
      }

      scoredCandidates.push({
        role,
        score,
        reasons
      });
    }

    // Sort descending by score
    scoredCandidates.sort((a, b) => b.score - a.score);

    const winner = scoredCandidates[0] || {
      role: candidateRoles[0],
      score: 50,
      reasons: ['Default domain role fallback']
    };

    const preparedConfig: PreparedAgentConfig = {
      roleId: winner.role.roleId,
      domainId: winner.role.domainId,
      title: winner.role.title,
      character: winner.role.character,
      systemPromptPreamble: winner.role.contextStrategy.systemPromptPreamble,
      recommendedSkills: winner.role.recommendedSkills,
      recommendedTools: winner.role.recommendedTools,
      verificationRules: winner.role.verificationRules,
      preferredProvider: winner.role.preferredProvider,
      preferredModel: winner.role.preferredModel,
      defaultBudgetTokens: winner.role.contextStrategy.defaultBudgetTokens
    };

    return {
      task,
      projectId: project.id,
      recommendedRole: winner.role,
      alternatives: scoredCandidates.slice(1),
      score: winner.score,
      reasons: winner.reasons,
      contextStrategy: winner.role.contextStrategy,
      preparedConfig,
      routedAt: Date.now()
    };
  }
}

function findGraphEvidenceForRole(role: DomainAgentRole, nodes: ProjectGraphNode[]): string[] {
  const matches: string[] = [];
  const roleId = role.roleId;

  for (const node of nodes) {
    const nameLower = node.name.toLowerCase();
    const pathLower = (node.path || '').toLowerCase();

    if (
      (roleId.startsWith('sec-') || roleId === 'sde-reviewer') &&
      (nameLower.includes('auth') || nameLower.includes('jwt') || nameLower.includes('token') || pathLower.includes('security') || pathLower.includes('auth'))
    ) {
      matches.push(node.name);
    } else if (
      roleId.startsWith('aiml-') &&
      (nameLower.includes('model') || nameLower.includes('train') || nameLower.includes('dataset') || pathLower.includes('pipeline'))
    ) {
      matches.push(node.name);
    } else if (
      (roleId === 'sde-tester' || roleId === 'sec-tester') &&
      (nameLower.includes('test') || pathLower.includes('test/'))
    ) {
      matches.push(node.name);
    } else if (
      (roleId === 'sde-engineer' || roleId === 'sde-debugger') &&
      (nameLower.includes('api') || nameLower.includes('db') || pathLower.includes('src/'))
    ) {
      matches.push(node.name);
    }

    if (matches.length >= 3) break;
  }

  return matches;
}
