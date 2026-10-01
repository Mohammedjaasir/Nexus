/**
 * Context Intelligence Engine.
 *
 * Given a project, task, domain, agent role, and context budget, deterministically
 * selects, ranks, tiers, and packages the minimum sufficient context from the Project Knowledge Graph.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { PersistStore } from '../db';
import type { ProjectGitMetadata } from '../../shared/project';
import type {
  ContextPackage,
  ContextItem,
  ContextProvenance,
  ContextTier,
  ContextProvenanceReason,
  ContextAssemblyOptions,
  ContextBenchmarkResult
} from '../../shared/context';
import type { ProjectGraphNode, ProjectGraphEdge } from '../../shared/graph';
import { safeJoin } from '../fs';
import { estimateTokens, estimateFileTokens } from './tokenEstimator';
import { extractTier2Signature, extractTier3Summary, extractTier4Metadata } from './codeSummarizer';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
  'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to',
  'was', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'fix', 'update',
  'issue', 'bug', 'error', 'problem', 'make', 'change', 'please', 'help', 'code', 'file'
]);

export interface RealisticBaselineScenario {
  tokens: number;
  fileCount: number;
  files: string[];
  symbolCount: number;
  content: string;
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'webm', 'mp4', 'mov', 'wasm',
  'zip', 'gz', 'tar', 'woff', 'woff2', 'ttf', 'eot', 'map', 'pdf'
]);

const GENERIC_HUB_FILES = new Set([
  'load-ts.cjs', 'tsconfig.json', 'package.json', 'package-lock.json',
  'electron.vite.config.ts', 'vite.config.ts', 'tsconfig.node.json', 'tsconfig.web.json'
]);

export class ContextEngine {
  constructor(private store: PersistStore) {}

  /**
   * Build an optimized context package for an agent task.
   */
  async assembleContext(
    projectId: string,
    task: string,
    options: ContextAssemblyOptions = {}
  ): Promise<ContextPackage> {
    const project = this.store.getProject(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const budget = options.budgetTokens ?? 32000;
    const rootPath = project.rootPath;

    // 1. Task Target Extraction
    const taskTokens = extractTaskKeywords(task);

    // 2. Knowledge Graph Node Retrieval
    const allNodes = this.store.getProjectGraphNodes(projectId);
    const allEdges = this.store.getProjectGraphEdges(projectId);

    // 3. Conservative Relevance Ranking & Graph Scoring
    const scoredNodes = scoreGraphNodes(allNodes, allEdges, taskTokens, options, project.gitInfo);

    // 4. Group by File and assign initial Context Tiers (filtering out binary / noise files)
    const selectedFilePaths = new Map<string, { score: number; reason: ContextProvenanceReason; node: ProjectGraphNode; depth: number }>();

    for (const item of scoredNodes) {
      if (item.score <= 0) continue;
      const filePath = item.node.path;
      if (filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase() || '';
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const existing = selectedFilePaths.get(filePath);
        if (!existing || item.score > existing.score) {
          selectedFilePaths.set(filePath, item);
        }
      }
    }

    // Sort candidates by relevance score descending
    const sortedCandidates = Array.from(selectedFilePaths.values()).sort((a, b) => b.score - a.score);

    // 5. Tier Assignment & Content Extraction
    const maxTier1 = options.maxTier1Files ?? 5;
    const items: ContextItem[] = [];
    const provenance: ContextProvenance[] = [];
    const warnings: string[] = [];

    let tier1Count = 0;
    for (let i = 0; i < sortedCandidates.length; i++) {
      const cand = sortedCandidates[i];
      const relPath = cand.node.path!;
      const absPath = safeJoin(rootPath, relPath);

      if (!absPath || !existsSync(absPath)) continue;

      let fileContent = '';
      try {
        fileContent = readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }

      // Determine tier based on depth, relevance provenance, and score:
      let tier: ContextTier = 'tier4_metadata';
      if (cand.depth === 0 && cand.score >= 70 && tier1Count < maxTier1) {
        tier = 'tier1_full';
        tier1Count++;
      } else if (cand.depth <= 1 && (cand.reason === 'test_dependency' || cand.reason === 'import_dependency' || cand.reason === 'call_dependency' || cand.score >= 40)) {
        tier = 'tier2_signature';
      } else if (cand.depth === 2 || cand.score >= 25) {
        tier = 'tier3_summary';
      } else {
        tier = 'tier4_metadata';
      }

      let renderedContent = '';
      if (tier === 'tier1_full') {
        renderedContent = `// === FULL FILE: ${relPath} ===\n${fileContent}`;
      } else if (tier === 'tier2_signature') {
        renderedContent = extractTier2Signature(fileContent, relPath);
      } else if (tier === 'tier3_summary') {
        renderedContent = extractTier3Summary(fileContent, relPath, [cand.node.name]);
      } else {
        renderedContent = extractTier4Metadata(relPath, cand.node.kind, cand.reason);
      }

      const itemTokens = estimateTokens(renderedContent);

      const item: ContextItem = {
        id: cand.node.id,
        name: cand.node.name,
        path: relPath,
        kind: cand.node.kind,
        tier,
        reason: cand.reason,
        score: cand.score,
        content: renderedContent,
        estimatedTokens: itemTokens,
        metadata: cand.node.metadata
      };

      items.push(item);
      provenance.push({
        targetId: cand.node.id,
        name: cand.node.name,
        path: relPath,
        reason: cand.reason,
        score: cand.score,
        tier,
        explanation: formatProvenanceExplanation(cand.node.name, cand.reason, cand.score, tier)
      });
    }

    // 6. Budget Measurement and Multi-Tier Knapsack Fitting
    let totalEstimatedTokens = items.reduce((acc, it) => acc + it.estimatedTokens, 0);

    if (totalEstimatedTokens > budget) {
      warnings.push(`Initial context (${totalEstimatedTokens} estimated tokens) exceeded budget (${budget} tokens); trimming applied.`);

      // Stage A: Downgrade Tier 1 to Tier 2
      for (const it of items) {
        if (totalEstimatedTokens <= budget) break;
        if (it.tier === 'tier1_full') {
          const abs = safeJoin(rootPath, it.path!);
          if (abs && existsSync(abs)) {
            const raw = readFileSync(abs, 'utf8');
            it.tier = 'tier2_signature';
            it.content = extractTier2Signature(raw, it.path!);
            const newTokens = estimateTokens(it.content);
            totalEstimatedTokens -= (it.estimatedTokens - newTokens);
            it.estimatedTokens = newTokens;
          }
        }
      }

      // Stage B: Downgrade Tier 2 to Tier 3
      for (const it of items) {
        if (totalEstimatedTokens <= budget) break;
        if (it.tier === 'tier2_signature' && it.score < 60) {
          const abs = safeJoin(rootPath, it.path!);
          if (abs && existsSync(abs)) {
            const raw = readFileSync(abs, 'utf8');
            it.tier = 'tier3_summary';
            it.content = extractTier3Summary(raw, it.path!, [it.name]);
            const newTokens = estimateTokens(it.content);
            totalEstimatedTokens -= (it.estimatedTokens - newTokens);
            it.estimatedTokens = newTokens;
          }
        }
      }

      // Stage C: Downgrade Tier 3 to Tier 4
      for (const it of items) {
        if (totalEstimatedTokens <= budget) break;
        if (it.tier === 'tier3_summary') {
          it.tier = 'tier4_metadata';
          it.content = extractTier4Metadata(it.path!, it.kind, it.reason);
          const newTokens = estimateTokens(it.content);
          totalEstimatedTokens -= (it.estimatedTokens - newTokens);
          it.estimatedTokens = newTokens;
        }
      }

      // Stage D: Drop lowest-scoring Tier 4 items until within budget
      while (totalEstimatedTokens > budget && items.length > 1) {
        const removed = items.pop();
        if (removed) {
          totalEstimatedTokens -= removed.estimatedTokens;
        }
      }
    }

    // 7. Calculate Baseline Context (Raw entire workspace size)
    const baselineTokens = calculateBaselineTokens(rootPath, allNodes);
    const reductionPercentage = baselineTokens > 0
      ? Math.max(0, Math.round((1 - totalEstimatedTokens / baselineTokens) * 100))
      : 0;

    // 8. Assemble Prompt Text
    const assembledText = assemblePromptContext(task, items, project.name);

    return {
      projectId,
      task,
      domainId: options.domainId || project.domainId,
      agentRole: options.agentRole,
      budgetTokens: budget,
      estimatedTokens: totalEstimatedTokens,
      baselineTokens,
      reductionPercentage,
      selectedFiles: Array.from(new Set(items.map((i) => i.path).filter(Boolean))) as string[],
      selectedNodes: items.map((i) => i.id),
      items,
      provenance,
      assembledText,
      warnings,
      generatedAt: Date.now()
    };
  }

  /**
   * Compute a realistic baseline context retrieval for a task (what a typical agent retrieves).
   */
  computeRealisticBaseline(
    projectId: string,
    task: string
  ): RealisticBaselineScenario {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const rootPath = project.rootPath;
    const taskTokens = extractTaskKeywords(task);

    const allNodes = this.store.getProjectGraphNodes(projectId);
    const candidateFiles = new Set<string>();

    for (const node of allNodes) {
      if (!node.path) continue;
      const ext = node.path.split('.').pop()?.toLowerCase() || '';
      if (BINARY_EXTENSIONS.has(ext)) continue;

      const nameLower = node.name.toLowerCase();
      const pathLower = node.path.toLowerCase();

      for (const kw of taskTokens.words) {
        if (nameLower.includes(kw) || pathLower.includes(kw)) {
          candidateFiles.add(node.path);
        }
      }
    }

    let totalTokens = 0;
    let totalSymbols = 0;
    const fullFiles: string[] = [];
    const contents: string[] = [];

    for (const relPath of candidateFiles) {
      const absPath = safeJoin(rootPath, relPath);
      if (!absPath || !existsSync(absPath)) continue;
      try {
        const raw = readFileSync(absPath, 'utf8');
        const tok = estimateFileTokens(raw);
        totalTokens += tok;
        fullFiles.push(relPath);
        contents.push(`// === BASELINE FILE: ${relPath} ===\n${raw}`);

        const symbolMatches = raw.match(/(?:function|class|interface|type|def|export const)\s+([A-Za-z0-9_$]+)/g) || [];
        totalSymbols += symbolMatches.length;
      } catch {
        // ignore
      }
    }

    return {
      tokens: totalTokens,
      fileCount: fullFiles.length,
      files: fullFiles,
      symbolCount: totalSymbols,
      content: contents.join('\n\n')
    };
  }

  /**
   * Run a benchmark measuring realistic baseline vs optimized context for a task.
   */
  async runBenchmark(
    projectId: string,
    task: string,
    budgetTokens = 32000
  ): Promise<ContextBenchmarkResult & { realisticBaselineTokens: number; realisticBaselineFiles: number; realisticReductionPercentage: number }> {
    const pkg = await this.assembleContext(projectId, task, { budgetTokens });
    const realisticBase = this.computeRealisticBaseline(projectId, task);
    const project = this.store.getProject(projectId);

    const tierCounts: Record<ContextTier, number> = {
      tier1_full: 0,
      tier2_signature: 0,
      tier3_summary: 0,
      tier4_metadata: 0
    };

    for (const it of pkg.items) {
      tierCounts[it.tier] = (tierCounts[it.tier] || 0) + 1;
    }

    const realisticReductionPercentage = realisticBase.tokens > 0
      ? Math.max(0, Math.round((1 - pkg.estimatedTokens / realisticBase.tokens) * 100))
      : 0;

    return {
      projectId,
      projectName: project?.name ?? projectId,
      task,
      budgetTokens,
      baselineTokens: pkg.baselineTokens,
      realisticBaselineTokens: realisticBase.tokens,
      realisticBaselineFiles: realisticBase.fileCount,
      realisticReductionPercentage,
      optimizedTokens: pkg.estimatedTokens,
      reductionPercentage: pkg.reductionPercentage,
      tierCounts,
      selectedFiles: pkg.selectedFiles,
      selectedNodes: pkg.selectedNodes,
      provenance: pkg.provenance,
      sampleAssembledContext: pkg.assembledText.slice(0, 1500) + '\n… [truncated for preview]'
    };
  }
}

// ─── Scoring and Assembly Helpers ───────────────────────────────────────────

function extractTaskKeywords(task: string): { words: string[]; fullTokens: string[] } {
  const normalized = task.toLowerCase();
  const rawTokens = normalized.match(/[a-z0-9_.-]+/g) || [];
  const words = rawTokens.filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return { words, fullTokens: rawTokens };
}

interface ScoredCandidate {
  node: ProjectGraphNode;
  score: number;
  reason: ContextProvenanceReason;
  depth: number;
}

function scoreGraphNodes(
  nodes: ProjectGraphNode[],
  edges: ProjectGraphEdge[],
  taskKeywords: { words: string[]; fullTokens: string[] },
  options: ContextAssemblyOptions,
  gitInfo?: ProjectGitMetadata | { recentCommits?: Array<{ modifiedFiles?: string[] }> }
): ScoredCandidate[] {
  const scores = new Map<string, { score: number; reason: ContextProvenanceReason; depth: number }>();
  const recentFiles = new Set<string>();

  if (gitInfo && 'recentCommits' in gitInfo && Array.isArray(gitInfo.recentCommits)) {
    for (const c of gitInfo.recentCommits.slice(0, 5)) {
      for (const mf of c.modifiedFiles || []) recentFiles.add(mf.replace(/\\/g, '/'));
    }
  }

  // 1. Depth 0: Direct Keyword Matching on Node Names & Paths
  for (const node of nodes) {
    let directScore = 0;
    const nameLower = node.name.toLowerCase();
    const pathLower = (node.path || '').toLowerCase();

    for (const kw of taskKeywords.words) {
      if (nameLower === kw) directScore += 100;
      else if (nameLower.includes(kw)) directScore += 50;
      else if (pathLower.includes(kw)) directScore += 40;
    }

    if (directScore > 0) {
      if (node.path && recentFiles.has(node.path)) {
        directScore += 25;
      }

      scores.set(node.id, { score: directScore, reason: 'direct_target', depth: 0 });

      // Propagate direct score to enclosing file
      if (node.path) {
        const parentFileId = `file:${node.path}`;
        const existing = scores.get(parentFileId);
        if (!existing || directScore > existing.score) {
          scores.set(parentFileId, { score: directScore, reason: 'direct_target', depth: 0 });
        }
      }
    }
  }

  // 2. Depth 1: Outgoing Imports, Direct Calls, and Direct Test Suites
  const depth0SeedIds = Array.from(scores.keys());
  for (const seedId of depth0SeedIds) {
    const seed = scores.get(seedId)!;
    if (seed.score < 60) continue;

    for (const edge of edges) {
      let targetId: string | null = null;
      let reason: ContextProvenanceReason = 'import_dependency';

      // Outgoing edges from direct target
      if (edge.source === seedId) {
        targetId = edge.target;
        if (edge.kind === 'imports') reason = 'import_dependency';
        else if (edge.kind === 'calls') reason = 'call_dependency';
        else if (edge.kind === 'defines') reason = 'direct_target';
        else if (edge.kind === 'depends_on') reason = 'import_dependency';
      }
      // Incoming tests targeting direct target
      else if (edge.target === seedId && edge.kind === 'tests') {
        targetId = edge.source;
        reason = 'test_dependency';
      }

      if (targetId) {
        const targetNode = nodes.find((n) => n.id === targetId);
        const targetPath = targetNode?.path ? targetNode.path.split('/').pop() : '';
        if (targetPath && GENERIC_HUB_FILES.has(targetPath)) continue;

        const boost = edge.kind === 'tests' ? 35 : edge.kind === 'imports' ? 30 : 20;
        const current = scores.get(targetId);
        const newScore = Math.max(current?.score ?? 0, Math.round(seed.score * 0.5) + boost);

        if (!current || (current.reason !== 'direct_target' && newScore > current.score)) {
          scores.set(targetId, { score: newScore, reason, depth: 1 });
        }
      }
    }
  }

  // 3. Depth 2: Secondary Dependencies (Only high-scoring Depth 1 nodes)
  const depth1Ids = Array.from(scores.entries()).filter(([_, v]) => v.depth === 1 && v.score >= 50);
  for (const [d1Id, d1Val] of depth1Ids) {
    for (const edge of edges) {
      if (edge.source === d1Id && (edge.kind === 'imports' || edge.kind === 'calls')) {
        const targetId = edge.target;
        const targetNode = nodes.find((n) => n.id === targetId);
        const targetPath = targetNode?.path ? targetNode.path.split('/').pop() : '';
        if (targetPath && GENERIC_HUB_FILES.has(targetPath)) continue;

        const current = scores.get(targetId);
        const newScore = Math.max(current?.score ?? 0, Math.round(d1Val.score * 0.4) + 15);

        if (!current) {
          scores.set(targetId, { score: newScore, reason: 'import_dependency', depth: 2 });
        }
      }
    }
  }

  // Map to candidate list
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const results: ScoredCandidate[] = [];

  for (const [id, { score, reason, depth }] of scores.entries()) {
    const node = nodeMap.get(id);
    if (node) {
      results.push({ node, score, reason, depth });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

function calculateBaselineTokens(rootPath: string, nodes: ProjectGraphNode[]): number {
  let total = 0;
  const fileNodes = nodes.filter((n) => n.kind === 'file' || n.kind === 'documentation');
  for (const fn of fileNodes) {
    if (fn.path) {
      const abs = safeJoin(rootPath, fn.path);
      if (abs && existsSync(abs)) {
        try {
          const content = readFileSync(abs, 'utf8');
          total += estimateFileTokens(content);
        } catch {
          // ignore
        }
      }
    }
  }
  return Math.max(total, 12000);
}

function assemblePromptContext(task: string, items: ContextItem[], projectName: string): string {
  const sections: string[] = [
    `# PROJECT CONTEXT FOR: ${projectName.toUpperCase()}`,
    `Task: "${task}"`,
    `Selected Context Items: ${items.length}`,
    ''
  ];

  const t1 = items.filter((i) => i.tier === 'tier1_full');
  const t2 = items.filter((i) => i.tier === 'tier2_signature');
  const t3 = items.filter((i) => i.tier === 'tier3_summary');
  const t4 = items.filter((i) => i.tier === 'tier4_metadata');

  if (t1.length > 0) {
    sections.push('## TIER 1: CORE TARGET FILES (FULL CONTENT)');
    for (const it of t1) {
      sections.push(it.content);
      sections.push('');
    }
  }

  if (t2.length > 0) {
    sections.push('## TIER 2: DEPENDENCIES & API SIGNATURES');
    for (const it of t2) {
      sections.push(it.content);
      sections.push('');
    }
  }

  if (t3.length > 0) {
    sections.push('## TIER 3: STRUCTURAL SUMMARIES');
    for (const it of t3) {
      sections.push(it.content);
      sections.push('');
    }
  }

  if (t4.length > 0) {
    sections.push('## TIER 4: RELATED METADATA');
    for (const it of t4) {
      sections.push(it.content);
    }
    sections.push('');
  }

  return sections.join('\n');
}

function formatProvenanceExplanation(
  name: string,
  reason: ContextProvenanceReason,
  score: number,
  tier: ContextTier
): string {
  const reasonMap: Record<ContextProvenanceReason, string> = {
    direct_target: 'directly matched task keywords or file path target',
    import_dependency: 'imported or required by a directly targeted file',
    call_dependency: 'called by functions in the active target path',
    test_dependency: 'associated test suite verifying the target module',
    recent_change: 'recently modified in Git history',
    domain_relevance: 'domain-specialized component for active domain',
    agent_role_relevance: 'role-specialized component for active agent'
  };

  return `${name} included as ${tier.toUpperCase()} (score: ${score}) because it is a ${reasonMap[reason]}.`;
}
