/**
 * Deterministic Project Knowledge Graph Extractor.
 *
 * Scans a project repository and builds an offline, reproducible graph of:
 * - folders & files (contains)
 * - documentation (documents)
 * - modules & dependencies (depends_on, imports)
 * - classes & functions (defines, calls)
 * - test suites & test cases (tests)
 * - API endpoints (defines)
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname, extname } from 'node:path';
import type {
  ProjectGraphNode,
  ProjectGraphEdge,
  ProjectGraphNodeKind,
  ProjectGraphRelationKind
} from '../../shared/graph';
import { safeJoin } from '../fs';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.vite',
  'coverage',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'target',
  '.gemini',
  '.agents',
  'logs',
  'blog'
]);

const MAX_FILES_FOR_GRAPH = 1500;
const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB

export interface ExtractedProjectGraph {
  projectId: string;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
}

export interface GraphFileChange {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
}

export function extractProjectKnowledgeGraph(
  projectId: string,
  rootPath: string,
  projectName?: string
): ExtractedProjectGraph {
  const nodesMap = new Map<string, ProjectGraphNode>();
  const edgesMap = new Map<string, ProjectGraphEdge>();

  function addNode(
    id: string,
    kind: ProjectGraphNodeKind,
    name: string,
    path?: string,
    metadata?: Record<string, unknown>
  ): ProjectGraphNode {
    const existing = nodesMap.get(id);
    if (existing) return existing;
    const node: ProjectGraphNode = { id, projectId, kind, name, path, metadata };
    nodesMap.set(id, node);
    return node;
  }

  function addEdge(
    source: string,
    target: string,
    kind: ProjectGraphRelationKind,
    metadata?: Record<string, unknown>
  ): void {
    if (source === target) return;
    const id = `edge:${source}->${kind}->${target}`;
    if (!edgesMap.has(id)) {
      edgesMap.set(id, { id, projectId, source, target, kind, metadata });
    }
  }

  // 1. Root Project Node
  const projectNodeId = `proj:${projectId}`;
  addNode(projectNodeId, 'project', projectName || basename(rootPath), '');

  // 2. Discover all relevant files and directories
  const discoveredFiles: string[] = [];
  const discoveredFolders = new Set<string>();

  function walk(currentDir: string): void {
    if (discoveredFiles.length >= MAX_FILES_FOR_GRAPH) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;
      const fullPath = join(currentDir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          const relDir = relative(rootPath, fullPath).replace(/\\/g, '/');
          discoveredFolders.add(relDir);
          walk(fullPath);
        } else if (st.isFile() && st.size <= MAX_FILE_SIZE_BYTES) {
          const relFile = relative(rootPath, fullPath).replace(/\\/g, '/');
          discoveredFiles.push(relFile);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(rootPath);
  const fileSet = new Set(discoveredFiles);

  // Create folder nodes and structural hierarchy
  for (const f of Array.from(discoveredFolders).sort()) {
    const folderId = `folder:${f}`;
    addNode(folderId, 'folder', basename(f), f);
    const parent = dirname(f).replace(/\\/g, '/');
    if (parent === '.' || !parent) {
      addEdge(projectNodeId, folderId, 'contains');
    } else {
      addEdge(`folder:${parent}`, folderId, 'contains');
    }
  }

  // 3. Process Manifests (Dependencies & Modules)
  // Node.js package.json
  const pkgPath = safeJoin(rootPath, 'package.json');
  if (pkgPath && existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const depName of Object.keys(deps)) {
        const modId = `mod:${depName}`;
        addNode(modId, 'module', depName, undefined, { version: deps[depName] });
        addEdge(projectNodeId, modId, 'depends_on');
      }
    } catch {
      // ignore
    }
  }

  // Python requirements.txt
  const reqPath = safeJoin(rootPath, 'requirements.txt');
  if (reqPath && existsSync(reqPath)) {
    try {
      const lines = readFileSync(reqPath, 'utf8').split('\n');
      for (const raw of lines) {
        const l = raw.trim();
        if (!l || l.startsWith('#')) continue;
        const depName = l.split(/[=><~]/)[0].trim();
        if (depName) {
          const modId = `mod:${depName}`;
          addNode(modId, 'module', depName);
          addEdge(projectNodeId, modId, 'depends_on');
        }
      }
    } catch {
      // ignore
    }
  }

  // Known symbols map for call graph resolution: name -> nodeId
  const declaredSymbols = new Map<string, string>();

  // 4. File-by-File Analysis
  for (const relPath of discoveredFiles) {
    const fileId = `file:${relPath}`;
    const ext = extname(relPath).toLowerCase().replace(/^\./, '');
    const isDoc = ['md', 'markdown', 'mdx', 'txt', 'rst'].includes(ext);
    const isTest =
      relPath.includes('.test.') ||
      relPath.includes('.spec.') ||
      relPath.includes('__tests__') ||
      basename(relPath).startsWith('test_');

    const fileNode = addNode(fileId, isDoc ? 'documentation' : 'file', basename(relPath), relPath, {
      extension: ext,
      isTest
    });

    // Link file into folder hierarchy
    const parentFolder = dirname(relPath).replace(/\\/g, '/');
    if (parentFolder === '.' || !parentFolder) {
      addEdge(projectNodeId, fileId, isDoc ? 'documents' : 'contains');
    } else {
      addEdge(`folder:${parentFolder}`, fileId, isDoc ? 'documents' : 'contains');
    }

    // Read and parse source code files
    const absPath = safeJoin(rootPath, relPath);
    if (!absPath || isDoc) continue;

    let content = '';
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }

    // A. Parse JavaScript / TypeScript
    if (['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs'].includes(ext)) {
      parseJsTsFile(content, relPath, fileId, addNode, addEdge, declaredSymbols, isTest, fileSet);
    }
    // B. Parse Python
    else if (ext === 'py') {
      parsePythonFile(content, relPath, fileId, addNode, addEdge, declaredSymbols, isTest, fileSet);
    }
    // C. Parse Rust
    else if (ext === 'rs') {
      parseRustFile(content, relPath, fileId, addNode, addEdge, declaredSymbols, isTest);
    }
    // D. Parse Go
    else if (ext === 'go') {
      parseGoFile(content, relPath, fileId, addNode, addEdge, declaredSymbols, isTest);
    }
  }

  // 5. Connect Calls and Tests Relationships
  for (const relPath of discoveredFiles) {
    const fileId = `file:${relPath}`;
    const absPath = safeJoin(rootPath, relPath);
    if (!absPath) continue;

    let content = '';
    try {
      content = readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }

    // If it's a test file, link tests edges to candidate source files
    if (relPath.includes('.test.') || relPath.includes('.spec.') || basename(relPath).startsWith('test_')) {
      const candidateSourceRel = relPath
        .replace(/\.test\./, '.')
        .replace(/\.spec\./, '.')
        .replace(/test_/, '')
        .replace(/^tests?\//, 'src/');

      const candidateFileId = `file:${candidateSourceRel}`;
      if (nodesMap.has(candidateFileId)) {
        addEdge(fileId, candidateFileId, 'tests');
      }
    }
  }

  return {
    projectId,
    nodes: Array.from(nodesMap.values()),
    edges: Array.from(edgesMap.values())
  };
}

function resolveRelativeImport(fromRelPath: string, target: string, fileSet?: Set<string>): string {
  const importedDir = dirname(fromRelPath).replace(/\\/g, '/');
  const rawNorm = join(importedDir, target).replace(/\\/g, '/');
  if (!fileSet) return `file:${rawNorm}`;
  if (fileSet.has(rawNorm)) return `file:${rawNorm}`;
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.py'];
  for (const ext of extensions) {
    if (fileSet.has(`${rawNorm}${ext}`)) return `file:${rawNorm}${ext}`;
    if (fileSet.has(`${rawNorm}/index${ext}`)) return `file:${rawNorm}/index${ext}`;
  }
  return `file:${rawNorm}`;
}

// ─── Language-specific parsing helpers ────────────────────────────────────────

function parseJsTsFile(
  content: string,
  relPath: string,
  fileId: string,
  addNode: (id: string, kind: ProjectGraphNodeKind, name: string, path?: string, metadata?: Record<string, unknown>) => ProjectGraphNode,
  addEdge: (source: string, target: string, kind: ProjectGraphRelationKind, metadata?: Record<string, unknown>) => void,
  symbols: Map<string, string>,
  isTest: boolean,
  fileSet?: Set<string>
): void {
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

    // 1. Imports
    if (line.startsWith('import ') || line.includes('require(')) {
      const fromMatch = line.match(/(?:from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)|import\s+['"]([^'"]+)['"])/);
      if (fromMatch) {
        const target = fromMatch[1] || fromMatch[2] || fromMatch[3];
        if (target) {
          if (target.startsWith('.')) {
            const resolvedTargetId = resolveRelativeImport(relPath, target, fileSet);
            addEdge(fileId, resolvedTargetId, 'imports');
          } else {
            const pkgName = target.startsWith('@') ? target.split('/').slice(0, 2).join('/') : target.split('/')[0];
            const modId = `mod:${pkgName}`;
            addNode(modId, 'module', pkgName);
            addEdge(fileId, modId, 'imports');
          }
        }
      }
    }

    // 2. Classes
    if (line.includes('class ')) {
      const classMatch = line.match(/(?:export\s+)?class\s+([A-Za-z0-9_$]+)/);
      if (classMatch) {
        const className = classMatch[1];
        const classId = `class:${relPath}#${className}`;
        addNode(classId, 'class', className, relPath);
        addEdge(fileId, classId, 'defines');
        symbols.set(className, classId);
      }
    }

    // 3. Functions
    if (line.includes('function ') || line.includes('=>') || line.includes('function(')) {
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/) ||
                      line.match(/(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/);
      if (fnMatch) {
        const fnName = fnMatch[1];
        if (fnName && fnName.length <= 40) {
          const fnId = `fn:${relPath}#${fnName}`;
          addNode(fnId, 'function', fnName, relPath);
          addEdge(fileId, fnId, 'defines');
          symbols.set(fnName, fnId);
        }
      }
    }

    // 4. API Endpoints
    if (line.includes('app.') || line.includes('router.')) {
      const apiMatch = line.match(/(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/i);
      if (apiMatch) {
        const method = apiMatch[1].toUpperCase();
        const route = apiMatch[2];
        const apiId = `api:${method}:${route}`;
        addNode(apiId, 'api_endpoint', `${method} ${route}`, relPath, { method, route });
        addEdge(fileId, apiId, 'defines');
      }
    }

    // 5. Test Suites and Test Cases
    if (isTest) {
      const suiteMatch = line.match(/(?:describe|suite)\s*\(\s*['"]([^'"]+)['"]/);
      if (suiteMatch) {
        const suiteName = suiteMatch[1];
        const suiteId = `suite:${relPath}#${suiteName}`;
        addNode(suiteId, 'test_suite', suiteName, relPath);
        addEdge(fileId, suiteId, 'defines');
      }

      const caseMatch = line.match(/(?:test|it)\s*\(\s*['"]([^'"]+)['"]/);
      if (caseMatch) {
        const caseName = caseMatch[1];
        const caseId = `case:${relPath}#${caseName}`;
        addNode(caseId, 'test_case', caseName, relPath);
        addEdge(fileId, caseId, 'defines');
      }
    }
  }
}

function parsePythonFile(
  content: string,
  relPath: string,
  fileId: string,
  addNode: (id: string, kind: ProjectGraphNodeKind, name: string, path?: string, metadata?: Record<string, unknown>) => ProjectGraphNode,
  addEdge: (source: string, target: string, kind: ProjectGraphRelationKind, metadata?: Record<string, unknown>) => void,
  symbols: Map<string, string>,
  isTest: boolean,
  _fileSet?: Set<string>
): void {
  // 1. Imports
  const importRegex = /(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    const mod = match[1] || match[2]?.split(',')[0]?.trim();
    if (!mod) continue;
    const topMod = mod.split('.')[0];
    const modId = `mod:${topMod}`;
    addNode(modId, 'module', topMod);
    addEdge(fileId, modId, 'imports');
  }

  // 2. Classes
  const classRegex = /class\s+([A-Za-z0-9_]+)(?:\s*\([^)]*\))?:/g;
  while ((match = classRegex.exec(content)) !== null) {
    const className = match[1];
    const classId = `class:${relPath}#${className}`;
    addNode(classId, 'class', className, relPath);
    addEdge(fileId, classId, 'defines');
    symbols.set(className, classId);
  }

  // 3. Functions
  const funcRegex = /def\s+([A-Za-z0-9_]+)\s*\(/g;
  while ((match = funcRegex.exec(content)) !== null) {
    const fnName = match[1];
    const fnId = `fn:${relPath}#${fnName}`;
    const isPyTest = fnName.startsWith('test_');
    if (isPyTest) {
      addNode(fnId, 'test_case', fnName, relPath);
    } else {
      addNode(fnId, 'function', fnName, relPath);
    }
    addEdge(fileId, fnId, 'defines');
    symbols.set(fnName, fnId);
  }

  // 4. FastAPI / Flask Routes
  const routeRegex = /@(?:app|router)\.(get|post|put|delete|patch|route)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const route = match[2];
    const apiId = `api:${method}:${route}`;
    addNode(apiId, 'api_endpoint', `${method} ${route}`, relPath, { method, route });
    addEdge(fileId, apiId, 'defines');
  }
}

function parseRustFile(
  content: string,
  relPath: string,
  fileId: string,
  addNode: (id: string, kind: ProjectGraphNodeKind, name: string, path?: string, metadata?: Record<string, unknown>) => ProjectGraphNode,
  addEdge: (source: string, target: string, kind: ProjectGraphRelationKind, metadata?: Record<string, unknown>) => void,
  symbols: Map<string, string>,
  _isTest: boolean
): void {
  // Structs / Traits (classes)
  const structRegex = /(?:pub\s+)?(?:struct|trait|enum)\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = structRegex.exec(content)) !== null) {
    const name = match[1];
    const id = `class:${relPath}#${name}`;
    addNode(id, 'class', name, relPath);
    addEdge(fileId, id, 'defines');
    symbols.set(name, id);
  }

  // Functions
  const fnRegex = /(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/g;
  while ((match = fnRegex.exec(content)) !== null) {
    const name = match[1];
    const id = `fn:${relPath}#${name}`;
    addNode(id, 'function', name, relPath);
    addEdge(fileId, id, 'defines');
    symbols.set(name, id);
  }
}

function parseGoFile(
  content: string,
  relPath: string,
  fileId: string,
  addNode: (id: string, kind: ProjectGraphNodeKind, name: string, path?: string, metadata?: Record<string, unknown>) => ProjectGraphNode,
  addEdge: (source: string, target: string, kind: ProjectGraphRelationKind, metadata?: Record<string, unknown>) => void,
  symbols: Map<string, string>,
  _isTest: boolean
): void {
  // Types
  const typeRegex = /type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/g;
  let match: RegExpExecArray | null;
  while ((match = typeRegex.exec(content)) !== null) {
    const name = match[1];
    const id = `class:${relPath}#${name}`;
    addNode(id, 'class', name, relPath);
    addEdge(fileId, id, 'defines');
    symbols.set(name, id);
  }

  // Functions
  const fnRegex = /func\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)\s*\(/g;
  while ((match = fnRegex.exec(content)) !== null) {
    const name = match[1];
    const id = `fn:${relPath}#${name}`;
    addNode(id, 'function', name, relPath);
    addEdge(fileId, id, 'defines');
    symbols.set(name, id);
  }
}

/**
 * Perform deterministic incremental update of a project's knowledge graph given a set of file changes.
 * Avoids full repository rescanning while preserving exact node and edge invariants.
 */
export function updateProjectKnowledgeGraphIncremental(
  projectId: string,
  rootPath: string,
  existingGraph: { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] },
  changes: GraphFileChange[]
): ExtractedProjectGraph {
  const nodesMap = new Map<string, ProjectGraphNode>();
  for (const n of existingGraph.nodes) {
    nodesMap.set(n.id, { ...n });
  }

  const edgesMap = new Map<string, ProjectGraphEdge>();
  for (const e of existingGraph.edges) {
    edgesMap.set(e.id, { ...e });
  }

  function addNode(
    id: string,
    kind: ProjectGraphNodeKind,
    name: string,
    path?: string,
    metadata?: Record<string, unknown>
  ): ProjectGraphNode {
    const existing = nodesMap.get(id);
    if (existing) {
      existing.kind = kind;
      existing.name = name;
      existing.path = path;
      if (metadata) existing.metadata = { ...(existing.metadata || {}), ...metadata };
      return existing;
    }
    const node: ProjectGraphNode = { id, projectId, kind, name, path, metadata };
    nodesMap.set(id, node);
    return node;
  }

  function addEdge(
    source: string,
    target: string,
    kind: ProjectGraphRelationKind,
    metadata?: Record<string, unknown>
  ): void {
    if (source === target) return;
    const id = `edge:${source}->${kind}->${target}`;
    if (!edgesMap.has(id)) {
      edgesMap.set(id, { id, projectId, source, target, kind, metadata });
    }
  }

  function removeNodesAndEdgesForPath(relPath: string): void {
    const normRel = relPath.replace(/\\/g, '/');
    const removedIds = new Set<string>();

    for (const [id, node] of nodesMap.entries()) {
      if (
        node.path === normRel ||
        id === `file:${normRel}` ||
        id === `doc:${normRel}` ||
        id === `test:${normRel}` ||
        (node.path && node.path.replace(/\\/g, '/') === normRel)
      ) {
        removedIds.add(id);
        nodesMap.delete(id);
      }
    }

    // Remove any edge where source or target is one of the removed nodes
    for (const [edgeId, edge] of edgesMap.entries()) {
      if (removedIds.has(edge.source) || removedIds.has(edge.target)) {
        edgesMap.delete(edgeId);
      }
    }
  }

  for (const change of changes) {
    const normPath = relative(rootPath, change.path.startsWith(rootPath) ? change.path : join(rootPath, change.path)).replace(/\\/g, '/');
    const normOldPath = change.oldPath
      ? relative(rootPath, change.oldPath.startsWith(rootPath) ? change.oldPath : join(rootPath, change.oldPath)).replace(/\\/g, '/')
      : undefined;

    // 1. Handle deletion or rename (cleanup old path)
    if (change.changeType === 'deleted') {
      removeNodesAndEdgesForPath(normPath);
      continue;
    } else if (change.changeType === 'renamed' && normOldPath) {
      removeNodesAndEdgesForPath(normOldPath);
    } else if (change.changeType === 'modified') {
      removeNodesAndEdgesForPath(normPath);
    }

    // 2. Handle addition / modification / renamed-target
    const absPath = safeJoin(rootPath, normPath);
    if (!absPath || !existsSync(absPath)) continue;

    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const ext = extname(normPath).toLowerCase();
    const fileName = basename(normPath);
    const isDoc = /\.(md|mdx|rst|txt|adoc)$/i.test(normPath);
    const isTest = /(?:test|spec)\.[a-z0-9]+$/i.test(normPath) || /tests?[\\/]/.test(normPath);

    let fileKind: ProjectGraphNodeKind = 'file';
    let fileId = `file:${normPath}`;

    if (isDoc) {
      fileKind = 'documentation';
      fileId = `doc:${normPath}`;
    } else if (isTest) {
      fileKind = 'test_suite';
      fileId = `test:${normPath}`;
    }

    addNode(fileId, fileKind, fileName, normPath, {
      sizeBytes: stat.size,
      extension: ext
    });

    // Link parent directory
    const parentRel = dirname(normPath).replace(/\\/g, '/');
    if (parentRel && parentRel !== '.') {
      const folderId = `folder:${parentRel}`;
      addNode(folderId, 'folder', basename(parentRel), parentRel);
      addEdge(folderId, fileId, 'contains');
    } else {
      const projNode = Array.from(nodesMap.values()).find((n) => n.kind === 'project');
      if (projNode) {
        addEdge(projNode.id, fileId, 'contains');
      }
    }

    // Parse file symbols & relationships
    if (stat.size <= MAX_FILE_SIZE_BYTES) {
      try {
        const content = readFileSync(absPath, 'utf8');
        const symbols = new Map<string, string>();

        if (['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'].includes(ext)) {
          parseJsTsFile(content, normPath, fileId, addNode, addEdge, symbols, isTest);
        } else if (ext === '.py') {
          parsePythonFile(content, normPath, fileId, addNode, addEdge, symbols, isTest);
        } else if (ext === '.rs') {
          parseRustFile(content, normPath, fileId, addNode, addEdge, symbols, isTest);
        } else if (ext === '.go') {
          parseGoFile(content, normPath, fileId, addNode, addEdge, symbols, isTest);
        }

        // Link test suite to source file if test
        if (isTest) {
          const candidateSourceRel = normPath
            .replace(/\.test\./, '.')
            .replace(/\.spec\./, '.')
            .replace(/test_/, '')
            .replace(/^tests?\//, 'src/');
          const candidateFileId = `file:${candidateSourceRel}`;
          if (nodesMap.has(candidateFileId)) {
            addEdge(fileId, candidateFileId, 'tests');
          }
        }
      } catch {
        // Continue on read/parse error
      }
    }
  }

  return {
    projectId,
    nodes: Array.from(nodesMap.values()),
    edges: Array.from(edgesMap.values())
  };
}
