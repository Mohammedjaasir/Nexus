/**
 * Core Project definitions for Nexus.
 *
 * Defines the Project abstraction, detected components, health metrics,
 * and scanning results for domain-specialized AI workspace execution.
 */

export type ProjectType =
  | 'library'
  | 'application'
  | 'monorepo'
  | 'cli'
  | 'service'
  | 'notebook_pipeline'
  | 'script'
  | 'unknown';

export interface ProjectDependency {
  name: string;
  version?: string;
  type: 'production' | 'development' | 'peer';
}

export interface ProjectTestSuite {
  framework: string;
  configPath?: string;
  testDirectory?: string;
  testCountEstimate?: number;
  testCommand?: string;
}

export interface ProjectLanguageStat {
  language: string;
  fileCount: number;
  extension: string;
}

export interface ProjectGitMetadata {
  isRepo: boolean;
  branch: string | null;
  isClean: boolean;
  lastCommit?: {
    sha: string;
    message: string;
    author: string;
    time: number;
  };
}

export interface ProjectHealthMetrics {
  healthScore: number; // 0 to 100
  hasTests: boolean;
  hasDocumentation: boolean;
  hasEntryPoints: boolean;
  hasGit: boolean;
  gitClean: boolean;
  dependencyCount: number;
  lastVerifiedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  domainId: string; // primary domain
  secondaryDomains?: string[];
  description?: string;
  projectType: ProjectType;
  detectedLanguages: ProjectLanguageStat[];
  frameworks: string[];
  dependencies: ProjectDependency[];
  entryPoints: string[];
  importantFiles: string[];
  testSuites: ProjectTestSuite[];
  documentationFiles: string[];
  gitInfo?: ProjectGitMetadata;
  health: ProjectHealthMetrics;
  lastAnalyzedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectScanResult {
  rootPath: string;
  suggestedName: string;
  suggestedDomainId: string; // backward-compatible alias of primaryDomain
  primaryDomain: string;
  secondaryDomains: string[];
  projectType: ProjectType;
  languages: ProjectLanguageStat[];
  frameworks: string[];
  dependencies: ProjectDependency[];
  entryPoints: string[];
  importantFiles: string[];
  testSuites: ProjectTestSuite[];
  documentationFiles: string[];
  gitInfo?: ProjectGitMetadata;
  health: ProjectHealthMetrics;
  summary: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  domainId: string;
  secondaryDomains?: string[];
  description?: string;
  projectType?: ProjectType;
}

export interface UpdateProjectInput {
  name?: string;
  domainId?: string;
  secondaryDomains?: string[];
  description?: string;
  projectType?: ProjectType;
}
