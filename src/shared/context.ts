/**
 * Core Context Intelligence Engine types for Nexus.
 *
 * Defines context tiers, ranking provenance, budget allocation,
 * and context packaging contracts for domain-specialized AI agents.
 */

export type ContextTier = 'tier1_full' | 'tier2_signature' | 'tier3_summary' | 'tier4_metadata';

export type ContextProvenanceReason =
  | 'direct_target'
  | 'import_dependency'
  | 'call_dependency'
  | 'test_dependency'
  | 'recent_change'
  | 'domain_relevance'
  | 'agent_role_relevance';

export interface ContextItem {
  id: string;
  name: string;
  path?: string;
  kind: string;
  tier: ContextTier;
  reason: ContextProvenanceReason;
  score: number;
  content: string; // The formatted text for this tier (full code, signature, summary, or metadata line)
  estimatedTokens: number;
  metadata?: Record<string, unknown>;
}

export interface ContextProvenance {
  targetId: string;
  name: string;
  path?: string;
  reason: ContextProvenanceReason;
  score: number;
  tier: ContextTier;
  explanation: string;
}

export interface ContextPackage {
  projectId: string;
  task: string;
  domainId?: string;
  agentRole?: string;
  budgetTokens: number;
  estimatedTokens: number;
  baselineTokens: number;
  reductionPercentage: number;
  selectedFiles: string[];
  selectedNodes: string[];
  items: ContextItem[];
  provenance: ContextProvenance[];
  assembledText: string;
  warnings: string[];
  generatedAt: number;
}

export interface ContextBenchmarkResult {
  projectId: string;
  projectName: string;
  task: string;
  budgetTokens: number;
  baselineTokens: number;
  optimizedTokens: number;
  reductionPercentage: number;
  tierCounts: Record<ContextTier, number>;
  selectedFiles: string[];
  selectedNodes: string[];
  provenance: ContextProvenance[];
  sampleAssembledContext: string;
}

export interface ContextAssemblyOptions {
  domainId?: string;
  agentRole?: string;
  budgetTokens?: number; // e.g. 16000, 32000, 64000, 128000
  includeTests?: boolean;
  includeDocs?: boolean;
  maxTier1Files?: number;
}
