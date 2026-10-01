/**
 * Core Knowledge Graph types for Munder Difflin.
 *
 * Models project-scoped graph nodes, relationships, query contracts, and statistics.
 */

export type ProjectGraphNodeKind =
  | 'project'
  | 'folder'
  | 'file'
  | 'module'
  | 'class'
  | 'function'
  | 'api_endpoint'
  | 'test_suite'
  | 'test_case'
  | 'documentation';

export type ProjectGraphRelationKind =
  | 'contains'
  | 'imports'
  | 'defines'
  | 'calls'
  | 'tests'
  | 'depends_on'
  | 'documents';

export interface ProjectGraphNode {
  id: string;
  projectId: string;
  kind: ProjectGraphNodeKind;
  name: string;
  path?: string; // repo-relative file or folder path
  metadata?: Record<string, unknown>;
}

export interface ProjectGraphEdge {
  id: string;
  projectId: string;
  source: string; // source node id
  target: string; // target node id
  kind: ProjectGraphRelationKind;
  metadata?: Record<string, unknown>;
}

export interface ProjectGraphStats {
  projectId: string;
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  functionCount: number;
  classCount: number;
  testCount: number;
  docCount: number;
  byKind: Record<string, number>;
  byRelation: Record<string, number>;
}

export interface ProjectSubgraph {
  rootNodeId: string;
  depth: number;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
}

export interface ProjectGraphQueryFilter {
  kind?: ProjectGraphNodeKind;
  path?: string;
  name?: string;
  limit?: number;
}
