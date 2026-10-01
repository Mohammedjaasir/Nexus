/**
 * Shared types for Project Gap Analysis in Munder Difflin (Phase 8B).
 */

export type GapStatus = 'completed' | 'in_progress' | 'missing' | 'blocked' | 'unknown';

export type GapCategory =
  | 'architecture'
  | 'implementation'
  | 'testing'
  | 'security'
  | 'data_pipeline'
  | 'model'
  | 'deployment'
  | 'documentation';

export interface ProjectGap {
  gapId: string;
  projectId: string;
  category: GapCategory;
  title: string;
  description: string;
  status: GapStatus;
  evidence: string[];
  confidence: number; // 0.0 to 1.0
  relevantGraphNodeIds: string[];
  suggestedTaskId?: string;
  isCritical: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConfidenceBreakdown {
  implementationEvidenceScore: number;
  testEvidenceScore: number;
  documentationEvidenceScore: number;
  criticalGapsPenalty: number;
  blockedPenalty: number;
}

export interface ProjectGapAnalysisResult {
  projectId: string;
  projectName: string;
  domainId: string;
  gaps: ProjectGap[];
  completionConfidence: number; // 0 to 100 percentage
  confidenceBreakdown: ConfidenceBreakdown;
  summary: {
    completedCount: number;
    inProgressCount: number;
    missingCount: number;
    blockedCount: number;
    unknownCount: number;
  };
  analyzedAt: number;
}
