/**
 * PersistStore — durable harness state in SQLite (better-sqlite3, synchronous).
 *
 * Phase A scope (the rest of the renderer state stays in localStorage for now):
 *   - kv:               scalar app state. Today: the main window's bounds.
 *   - command_history:  NET-NEW — every prompt the user submits to an agent.
 *
 * Lives in the Electron MAIN process (better-sqlite3 is native + synchronous);
 * the renderer reaches it over IPC. The DB file sits next to config.json under
 * app.getPath('userData'). WAL mode so reads never block the single writer.
 *
 * Schema evolves via PRAGMA user_version migrations: an ordered array where
 * migration N runs when user_version < N+1, then bumps it. NEVER edit a shipped
 * migration — only append. Phases B/C (agents + message_queue mirror) and the
 * cross-lane cost_ledger are reserved as future additive migrations (see below);
 * they are deliberately NOT built in v1.
 */
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'node:path';
import type { Project } from '../shared/project';
import type {
  ProjectGraphNode,
  ProjectGraphEdge,
  ProjectGraphStats,
  ProjectSubgraph,
  ProjectGraphNodeKind,
  ProjectGraphRelationKind,
  ProjectGraphQueryFilter
} from '../shared/graph';
import type { ProjectPlan } from '../shared/plan';
import type { ProjectGapAnalysisResult } from '../shared/gap';
import type { ProjectGoal } from '../shared/goal';
import { LegacyWriteQueue } from './legacyWriteQueue';

/** A captured user prompt, as returned to the renderer (camelCase columns). */
export interface CommandHistoryRow {
  id: number;
  agentId: string;
  cwd: string | null;
  text: string;
  ts: number;
}

/**
 * Ordered, append-only migrations. Index N takes the DB from user_version N to
 * N+1. To evolve the schema, APPEND a new function — never edit an existing one
 * (shipped DBs have already run it).
 *
 * FUTURE (do NOT build in v1 — reserved so the array isn't painted into a corner):
 *   - Phase B: `agents` + `message_queue` mirror of the renderer roster/queues
 *     (dual-write), enabling the eventual authority flip off localStorage.
 *   - Cross-lane (Lane A #6): migrate Jim's cost ledger onto this DB so his
 *     circuit-breaker can move off transcript-polling. Column names match his
 *     <harnessHome>/hive/cost-ledger.jsonl keys 1:1 for a straight INSERT…SELECT
 *     (coordinated w/ jim-mq290qkn 2026-06-06):
 *       cost_ledger(id, agent_id, session_id TEXT, ts, input, output,
 *                   cache_read, cache_creation, model TEXT, usd REAL)
 *     Rows are CUMULATIVE snapshots (one per agent per heartbeat beat) — diff
 *     consecutive rows for velocity; index (agent_id, session_id, ts). Additive;
 *     lands as a later migration.
 */

const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // → user_version 1 (Phase A): scalar kv + net-new command history.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,     -- JSON-encoded
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        cwd      TEXT,
        text     TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ch_agent_ts ON command_history(agent_id, ts DESC);
    `);
  },
  // → user_version 2: Projects table for domain-specialized AI workspaces.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        root_path        TEXT NOT NULL,
        domain_id        TEXT NOT NULL,
        project_type     TEXT NOT NULL,
        description      TEXT,
        metadata_json    TEXT NOT NULL,
        health_json      TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        last_analyzed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_projects_domain ON projects(domain_id);
    `);
  },
  // → user_version 3: Project Knowledge Graph nodes and edges
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_graph_nodes (
        id            TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        name          TEXT NOT NULL,
        path          TEXT,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_proj_kind ON project_graph_nodes(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_proj_path ON project_graph_nodes(project_id, path);

      CREATE TABLE IF NOT EXISTS project_graph_edges (
        id            TEXT NOT NULL,
        project_id    TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        target_id     TEXT NOT NULL,
        kind          TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (project_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON project_graph_edges(project_id, source_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON project_graph_edges(project_id, target_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON project_graph_edges(project_id, kind);
    `);
  },
  // → user_version 4: Project plans (milestones, tasks, progress)
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_plans (
        project_id TEXT PRIMARY KEY,
        plan_json  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_plans_updated ON project_plans(updated_at DESC);
    `);
  },
  // → user_version 5: Project gap analysis records
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_gaps (
        project_id TEXT PRIMARY KEY,
        gaps_json  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_gaps_updated ON project_gaps(updated_at DESC);
    `);
  },
  // → user_version 6: Project goals & required capabilities
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_goals (
        project_id TEXT PRIMARY KEY,
        goal_json  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_project_goals_updated ON project_goals(updated_at DESC);
    `);
  }
];

export class PersistStore {
  private db: Database.Database | null = null;
  /** Every write goes through this queue: a failed, early or paused write is retried, never dropped. */
  private readonly queue = new LegacyWriteQueue({ isReady: () => this.db !== null });

  /** @param dbPath  Override the DB location (tests). Defaults to userData/harness.db. */
  constructor(private dbPath?: string) {}

  /** Open (creating if needed) and migrate the DB. Idempotent — a second call is
   *  a no-op. Throws if the native module fails to load or the file is unusable;
   *  callers should guard so a DB failure can't crash app startup. */
  open(): void {
    if (this.db) return;
    const path = this.dbPath ?? join(app.getPath('userData'), 'harness.db');
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    this.migrate(db);
    this.db = db;
    // Anything written before the DB was open (or while paused) goes in now, in order.
    this.queue.flush(() => this.db !== null);
  }

  private migrate(db: Database.Database): void {
    const version = db.pragma('user_version', { simple: true }) as number;
    for (let i = version; i < MIGRATIONS.length; i++) {
      // Each migration + its version bump run in one transaction so a crash
      // mid-migration never leaves a half-applied schema at the wrong version.
      const run = db.transaction(() => {
        MIGRATIONS[i](db);
        db.pragma(`user_version = ${i + 1}`);
      });
      run();
    }
  }

  /** Close the handle (checkpoints WAL). Safe to call when already closed. */
  close(): void {
    // One last synchronous attempt (it stops at the first failure, so shutdown is
    // bounded by one busy_timeout), then say what could not be saved.
    try { this.queue.flush(() => this.db !== null); } catch (e) { console.error('[legacy-store] final flush failed:', e); }
    this.queue.dispose();
    if (this.queue.size > 0) {
      console.error(`[legacy-store] closing with ${this.queue.size} unsaved write(s): ${this.queue.pendingLabels().join(', ')}`);
    }
    try { this.db?.close(); } catch { /* best-effort on shutdown */ }
    this.db = null;
  }

  get isOpen(): boolean { return this.db !== null; }

  /** Number of writes waiting to be (re)tried. */
  get pendingWrites(): number { return this.queue.size; }

  /** Hold all writes (a migration is running). They queue and flush on resumeWrites(). */
  pauseWrites(): void { this.queue.pause(); }

  resumeWrites(): { written: number; remaining: number } {
    return this.queue.resume(() => this.db !== null);
  }

  private requireDb(): Database.Database {
    if (!this.db) throw new Error('database is not open');
    return this.db;
  }

  private write(label: string, run: (db: Database.Database) => void, key?: string): void {
    this.queue.submit(label, () => {
      if (!this.db) throw new Error('database is not open');
      run(this.db);
    }, this.db !== null, key);
  }

  // ─── kv (scalar app state) ─────────────────────────────────────────────────

  /** Read a JSON-decoded scalar, or undefined if absent/unparseable. */
  getKv<T = unknown>(key: string): T | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return undefined; }
  }

  /** Upsert a JSON-encoded scalar. */
  setKv(key: string, value: unknown): void {
    // Serialize now so a retry writes this value, not whatever the object became later.
    const json = JSON.stringify(value);
    const at = Date.now();
    this.write('setKv', (db) => {
      db.prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, json, at);
    }, `kv:${key}`);
  }

  // ─── command history (net-new) ─────────────────────────────────────────────

  /** Record one submitted prompt. Empty text or missing agent id are ignored. */
  addHistory(entry: { agentId: string; cwd?: string | null; text: string }): void {
    const text = (entry.text ?? '').trim();
    if (!text || !entry.agentId) return;
    const ts = Date.now();
    this.write('addHistory', (db) => {
      db.prepare('INSERT INTO command_history (agent_id, cwd, text, ts) VALUES (?, ?, ?, ?)')
        .run(entry.agentId, entry.cwd ?? null, text, ts);
    });
  }

  /** Most-recent-first history, optionally scoped to one agent. */
  listHistory(agentId?: string, limit = 100): CommandHistoryRow[] {
    if (!this.db) return [];
    const lim = clampLimit(limit, 100);
    const rows = agentId
      ? this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(agentId, lim)
      : this.db.prepare(
          'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history ORDER BY ts DESC, id DESC LIMIT ?'
        ).all(lim);
    return rows as CommandHistoryRow[];
  }

  searchHistory(query: string, limit = 50): CommandHistoryRow[] {
    if (!this.db) return [];
    const q = (query ?? '').trim();
    if (!q) return [];
    const lim = clampLimit(limit, 50);
    // Escape LIKE wildcards so a literal % or _ in the query isn't a metachar.
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(
      "SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC LIMIT ?"
    ).all(needle, lim) as CommandHistoryRow[];
  }

  // ─── projects (domain-specialized workspaces) ─────────────────────────────

  /** Save or overwrite a project. */
  saveProject(project: Project): void {
    const snap: Project = { ...project };
    this.write('saveProject', (db) => this.saveProjectNow(db, snap), `project:${project.id}`);
  }

  private saveProjectNow(db: Database.Database, project: Project): void {
    const metadata = {
      secondaryDomains: project.secondaryDomains ?? [],
      detectedLanguages: project.detectedLanguages ?? [],
      frameworks: project.frameworks ?? [],
      dependencies: project.dependencies ?? [],
      entryPoints: project.entryPoints ?? [],
      importantFiles: project.importantFiles ?? [],
      testSuites: project.testSuites ?? [],
      documentationFiles: project.documentationFiles ?? [],
      gitInfo: project.gitInfo
    };

    const healthJson = JSON.stringify(project.health ?? { healthScore: 0 });
    const metadataJson = JSON.stringify(metadata);
    db.prepare(`
      INSERT INTO projects (
        id, name, root_path, domain_id, project_type, description,
        metadata_json, health_json, created_at, updated_at, last_analyzed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        root_path = excluded.root_path,
        domain_id = excluded.domain_id,
        project_type = excluded.project_type,
        description = excluded.description,
        metadata_json = excluded.metadata_json,
        health_json = excluded.health_json,
        updated_at = excluded.updated_at,
        last_analyzed_at = excluded.last_analyzed_at
    `).run(
      project.id,
      project.name,
      project.rootPath,
      project.domainId,
      project.projectType,
      project.description ?? null,
      metadataJson,
      healthJson,
      project.createdAt || Date.now(),
      project.updatedAt || Date.now(),
      project.lastAnalyzedAt || Date.now()
    );
  }

  /** Read a project by ID. */
  getProject(id: string): Project | null {
    if (!this.db || !id) return null;
    const row = this.db.prepare(
      'SELECT * FROM projects WHERE id = ?'
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return deserializeProjectRow(row);
  }

  /** List all projects ordered by most recently updated. */
  listProjects(): Project[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM projects ORDER BY updated_at DESC'
    ).all() as Record<string, unknown>[];
    return rows.map(deserializeProjectRow).filter((p): p is Project => p !== null);
  }

  /** Update an existing project partially. */
  updateProject(id: string, patch: Partial<Project>): Project | null {
    // Read-modify-write. When the DB is not open this returns null (as before)
    // and logs. When it is open and the read or write throws, the WHOLE operation
    // is queued, so the retry re-reads and applies the patch to the latest row.
    if (!this.db) { console.error(`[legacy-store] updateProject(${id}) skipped: database is not open`); return null; }
    let result: Project | null = null;
    const outcome = this.queue.submit('updateProject', () => {
      const existing = this.getProject(id);
      if (!existing) { result = null; return; }
      const updated: Project = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
      this.saveProjectNow(this.requireDb(), updated);
      result = updated;
    }, true);
    if (outcome === 'written') return result;
    // Queued: hand back the best-known optimistic value (null when it cannot be read).
    try {
      const existing = this.getProject(id);
      return existing ? { ...existing, ...patch, id: existing.id, updatedAt: Date.now() } : null;
    } catch { return null; }
  }

  /** Delete a project by ID. Returns true if removed. */
  deleteProject(id: string): boolean {
    // Same contract as updateProject: not open -> false + log; open and the
    // write throws -> the whole operation is queued (returns whether the row was seen).
    if (!id) return false;
    if (!this.db) { console.error(`[legacy-store] deleteProject(${id}) skipped: database is not open`); return false; }
    let removed = false;
    const outcome = this.queue.submit('deleteProject', () => {
      const db = this.db;
      if (!db) throw new Error('database is not open');
      const res = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      if (this.getActiveProjectId() === id) db.prepare(
          `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run('active_project_id', 'null', Date.now());
      removed = res.changes > 0;
    }, true);
    if (outcome === 'written') return removed;
    try { return this.getProject(id) !== null; } catch { return false; }
  }

  /** Get active project ID from kv store. */
  getActiveProjectId(): string | null {
    return this.getKv<string>('active_project_id') ?? null;
  }

  /** Set active project ID in kv store. */
  setActiveProjectId(id: string | null): void {
    this.setKv('active_project_id', id); // queued (coalesced per key) like every kv write
  }

  // ─── project knowledge graph ──────────────────────────────────────────────

  /**
   * Save a project's knowledge graph (nodes + edges) in an atomic transaction.
   * Replaces any existing graph for this projectId.
   */
  saveProjectGraph(projectId: string, nodes: ProjectGraphNode[], edges: ProjectGraphEdge[]): void {
    if (!projectId) return;
    this.write('saveProjectGraph', (db) => this.saveProjectGraphNow(db, projectId, nodes, edges), `graph:${projectId}`);
  }

  private saveProjectGraphNow(db: Database.Database, projectId: string, nodes: ProjectGraphNode[], edges: ProjectGraphEdge[]): void {
    const deleteNodes = db.prepare('DELETE FROM project_graph_nodes WHERE project_id = ?');
    const deleteEdges = db.prepare('DELETE FROM project_graph_edges WHERE project_id = ?');

    const insertNode = db.prepare(`
      INSERT INTO project_graph_nodes (id, project_id, kind, name, path, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT INTO project_graph_edges (id, project_id, source_id, target_id, kind, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      deleteNodes.run(projectId);
      deleteEdges.run(projectId);

      for (const node of nodes) {
        insertNode.run(
          node.id,
          projectId,
          node.kind,
          node.name,
          node.path ?? null,
          JSON.stringify(node.metadata ?? {})
        );
      }

      for (const edge of edges) {
        insertEdge.run(
          edge.id,
          projectId,
          edge.source,
          edge.target,
          edge.kind,
          JSON.stringify(edge.metadata ?? {})
        );
      }
    });

    tx();
  }

  /** Get a single graph node by ID. */
  getProjectGraphNode(projectId: string, nodeId: string): ProjectGraphNode | null {
    if (!this.db || !projectId || !nodeId) return null;
    const row = this.db.prepare(
      'SELECT id, project_id AS projectId, kind, name, path, metadata_json FROM project_graph_nodes WHERE project_id = ? AND id = ?'
    ).get(projectId, nodeId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return deserializeGraphNodeRow(row);
  }

  /** Get nodes for a project with optional filtering. */
  getProjectGraphNodes(projectId: string, filter?: ProjectGraphQueryFilter): ProjectGraphNode[] {
    if (!this.db || !projectId) return [];
    let query = 'SELECT id, project_id AS projectId, kind, name, path, metadata_json FROM project_graph_nodes WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filter?.kind) {
      query += ' AND kind = ?';
      params.push(filter.kind);
    }
    if (filter?.path) {
      query += ' AND path = ?';
      params.push(filter.path);
    }
    if (filter?.name) {
      query += ' AND name LIKE ?';
      params.push(`%${filter.name}%`);
    }

    query += ' ORDER BY kind ASC, name ASC';
    if (filter?.limit) {
      query += ' LIMIT ?';
      params.push(clampLimit(filter.limit, 100));
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(deserializeGraphNodeRow).filter((n): n is ProjectGraphNode => n !== null);
  }

  /** Get edges for a project with optional filtering. */
  getProjectGraphEdges(
    projectId: string,
    filter?: { sourceId?: string; targetId?: string; kind?: ProjectGraphRelationKind; limit?: number }
  ): ProjectGraphEdge[] {
    if (!this.db || !projectId) return [];
    let query = 'SELECT id, project_id AS projectId, source_id AS source, target_id AS target, kind, metadata_json FROM project_graph_edges WHERE project_id = ?';
    const params: unknown[] = [projectId];

    if (filter?.sourceId) {
      query += ' AND source_id = ?';
      params.push(filter.sourceId);
    }
    if (filter?.targetId) {
      query += ' AND target_id = ?';
      params.push(filter.targetId);
    }
    if (filter?.kind) {
      query += ' AND kind = ?';
      params.push(filter.kind);
    }

    if (filter?.limit) {
      query += ' LIMIT ?';
      params.push(clampLimit(filter.limit, 500));
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(deserializeGraphEdgeRow).filter((e): e is ProjectGraphEdge => e !== null);
  }

  /** Get direct neighbors and edges connected to a node. */
  getProjectGraphNeighbors(
    projectId: string,
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both' = 'both'
  ): { nodes: ProjectGraphNode[]; edges: ProjectGraphEdge[] } {
    if (!this.db || !projectId || !nodeId) return { nodes: [], edges: [] };

    let edgeQuery = 'SELECT id, project_id AS projectId, source_id AS source, target_id AS target, kind, metadata_json FROM project_graph_edges WHERE project_id = ? AND ';
    if (direction === 'outgoing') {
      edgeQuery += 'source_id = ?';
    } else if (direction === 'incoming') {
      edgeQuery += 'target_id = ?';
    } else {
      edgeQuery += '(source_id = ? OR target_id = ?)';
    }

    const edgeParams = direction === 'both' ? [projectId, nodeId, nodeId] : [projectId, nodeId];
    const edgeRows = this.db.prepare(edgeQuery).all(...edgeParams) as Record<string, unknown>[];
    const edges = edgeRows.map(deserializeGraphEdgeRow).filter((e): e is ProjectGraphEdge => e !== null);

    const neighborIds = new Set<string>();
    for (const e of edges) {
      if (e.source !== nodeId) neighborIds.add(e.source);
      if (e.target !== nodeId) neighborIds.add(e.target);
    }

    if (neighborIds.size === 0) return { nodes: [], edges };

    const placeholders = Array.from(neighborIds).map(() => '?').join(',');
    const nodeRows = this.db.prepare(
      `SELECT id, project_id AS projectId, kind, name, path, metadata_json FROM project_graph_nodes WHERE project_id = ? AND id IN (${placeholders})`
    ).all(projectId, ...neighborIds) as Record<string, unknown>[];

    const nodes = nodeRows.map(deserializeGraphNodeRow).filter((n): n is ProjectGraphNode => n !== null);
    return { nodes, edges };
  }

  /**
   * Traverse a subgraph up to N depth levels around a root node.
   */
  getProjectSubgraph(projectId: string, rootNodeId: string, depth = 1): ProjectSubgraph {
    if (!this.db || !projectId || !rootNodeId) {
      return { rootNodeId, depth, nodes: [], edges: [] };
    }

    const maxDepth = Math.max(1, Math.min(5, depth));
    const visitedNodeIds = new Set<string>([rootNodeId]);
    const collectedEdges = new Map<string, ProjectGraphEdge>();
    let currentFrontier = new Set<string>([rootNodeId]);

    for (let d = 0; d < maxDepth; d++) {
      if (currentFrontier.size === 0) break;
      const nextFrontier = new Set<string>();

      const placeholders = Array.from(currentFrontier).map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, project_id AS projectId, source_id AS source, target_id AS target, kind, metadata_json
        FROM project_graph_edges
        WHERE project_id = ? AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
      `).all(projectId, ...currentFrontier, ...currentFrontier) as Record<string, unknown>[];

      for (const row of rows) {
        const edge = deserializeGraphEdgeRow(row);
        if (!edge) continue;
        collectedEdges.set(edge.id, edge);

        if (!visitedNodeIds.has(edge.source)) {
          visitedNodeIds.add(edge.source);
          nextFrontier.add(edge.source);
        }
        if (!visitedNodeIds.has(edge.target)) {
          visitedNodeIds.add(edge.target);
          nextFrontier.add(edge.target);
        }
      }

      currentFrontier = nextFrontier;
    }

    // Retrieve all visited nodes
    const nodePlaceholders = Array.from(visitedNodeIds).map(() => '?').join(',');
    const nodeRows = this.db.prepare(`
      SELECT id, project_id AS projectId, kind, name, path, metadata_json
      FROM project_graph_nodes
      WHERE project_id = ? AND id IN (${nodePlaceholders})
    `).all(projectId, ...visitedNodeIds) as Record<string, unknown>[];

    const nodes = nodeRows.map(deserializeGraphNodeRow).filter((n): n is ProjectGraphNode => n !== null);
    return {
      rootNodeId,
      depth: maxDepth,
      nodes,
      edges: Array.from(collectedEdges.values())
    };
  }

  /** Get statistical overview of a project's knowledge graph. */
  getProjectGraphStats(projectId: string): ProjectGraphStats {
    const emptyStats: ProjectGraphStats = {
      projectId,
      nodeCount: 0,
      edgeCount: 0,
      fileCount: 0,
      functionCount: 0,
      classCount: 0,
      testCount: 0,
      docCount: 0,
      byKind: {},
      byRelation: {}
    };

    if (!this.db || !projectId) return emptyStats;

    // Node statistics
    const nodeKinds = this.db.prepare(`
      SELECT kind, COUNT(*) AS count
      FROM project_graph_nodes
      WHERE project_id = ?
      GROUP BY kind
    `).all(projectId) as { kind: string; count: number }[];

    let totalNodes = 0;
    const byKind: Record<string, number> = {};
    for (const r of nodeKinds) {
      byKind[r.kind] = Number(r.count);
      totalNodes += Number(r.count);
    }

    // Edge statistics
    const edgeKinds = this.db.prepare(`
      SELECT kind, COUNT(*) AS count
      FROM project_graph_edges
      WHERE project_id = ?
      GROUP BY kind
    `).all(projectId) as { kind: string; count: number }[];

    let totalEdges = 0;
    const byRelation: Record<string, number> = {};
    for (const r of edgeKinds) {
      byRelation[r.kind] = Number(r.count);
      totalEdges += Number(r.count);
    }

    return {
      projectId,
      nodeCount: totalNodes,
      edgeCount: totalEdges,
      fileCount: byKind['file'] ?? 0,
      functionCount: byKind['function'] ?? 0,
      classCount: byKind['class'] ?? 0,
      testCount: (byKind['test_suite'] ?? 0) + (byKind['test_case'] ?? 0),
      docCount: byKind['documentation'] ?? 0,
      byKind,
      byRelation
    };
  }

  /** Delete a project's knowledge graph entirely. */
  deleteProjectGraph(projectId: string): void {
    if (!projectId) return;
    this.write('deleteProjectGraph', (db) => db.transaction(() => {
      db.prepare('DELETE FROM project_graph_nodes WHERE project_id = ?').run(projectId);
      db.prepare('DELETE FROM project_graph_edges WHERE project_id = ?').run(projectId);
    })(), `graph:${projectId}`);
  }

  // ─── Phase 8A: Project Plans ──────────────────────────────────────────────

  /** Retrieve the persisted milestone and task graph plan for a project. */
  getProjectPlan(projectId: string): ProjectPlan | null {
    if (!this.db || !projectId) return null;
    const row = this.db
      .prepare('SELECT plan_json FROM project_plans WHERE project_id = ?')
      .get(projectId) as { plan_json?: string } | undefined;

    if (!row?.plan_json) return null;
    try {
      return JSON.parse(row.plan_json) as ProjectPlan;
    } catch {
      return null;
    }
  }

  /** Save or update a project's milestone and task graph plan. */
  saveProjectPlan(plan: ProjectPlan): void {
    if (!plan?.projectId) return;
    const json = JSON.stringify(plan);
    const at = Date.now();
    this.write('saveProjectPlan', (db) => db
      .prepare(
        `INSERT INTO project_plans (project_id, plan_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           plan_json  = excluded.plan_json,
           updated_at = excluded.updated_at`
      )
      .run(plan.projectId, json, at), `plan:${plan.projectId}`);
  }

  /** Delete a project's plan. */
  deleteProjectPlan(projectId: string): void {
    if (!projectId) return;
    this.write('deleteProjectPlan', (db) => db.prepare('DELETE FROM project_plans WHERE project_id = ?').run(projectId), `plan:${projectId}`);
  }

  // ─── Phase 8B: Project Gap Analysis Records ───────────────────────────────

  /** Retrieve the persisted gap analysis result for a project. */
  getProjectGapAnalysis(projectId: string): ProjectGapAnalysisResult | null {
    if (!this.db || !projectId) return null;
    const row = this.db
      .prepare('SELECT gaps_json FROM project_gaps WHERE project_id = ?')
      .get(projectId) as { gaps_json?: string } | undefined;

    if (!row?.gaps_json) return null;
    try {
      return JSON.parse(row.gaps_json) as ProjectGapAnalysisResult;
    } catch {
      return null;
    }
  }

  /** Save or update a project's gap analysis result. */
  saveProjectGapAnalysis(result: ProjectGapAnalysisResult): void {
    if (!result?.projectId) return;
    const json = JSON.stringify(result);
    const at = Date.now();
    this.write('saveProjectGapAnalysis', (db) => db
      .prepare(
        `INSERT INTO project_gaps (project_id, gaps_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           gaps_json  = excluded.gaps_json,
           updated_at = excluded.updated_at`
      )
      .run(result.projectId, json, at), `gaps:${result.projectId}`);
  }

  /** Delete a project's gap analysis records. */
  deleteProjectGapAnalysis(projectId: string): void {
    if (!projectId) return;
    this.write('deleteProjectGapAnalysis', (db) => db.prepare('DELETE FROM project_gaps WHERE project_id = ?').run(projectId), `gaps:${projectId}`);
  }

  // ─── Phase 8C: Project Goals & Required Capabilities ──────────────────────

  /** Retrieve the persisted project goal. */
  getProjectGoal(projectId: string): ProjectGoal | null {
    if (!this.db || !projectId) return null;
    const row = this.db
      .prepare('SELECT goal_json FROM project_goals WHERE project_id = ?')
      .get(projectId) as { goal_json?: string } | undefined;

    if (!row?.goal_json) return null;
    try {
      return JSON.parse(row.goal_json) as ProjectGoal;
    } catch {
      return null;
    }
  }

  /** Save or update a project's goal definition. */
  saveProjectGoal(goal: ProjectGoal): void {
    if (!goal?.projectId) return;
    const json = JSON.stringify(goal);
    const at = Date.now();
    this.write('saveProjectGoal', (db) => db
      .prepare(
        `INSERT INTO project_goals (project_id, goal_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           goal_json  = excluded.goal_json,
           updated_at = excluded.updated_at`
      )
      .run(goal.projectId, json, at), `goal:${goal.projectId}`);
  }

  /** Delete a project's goal records. */
  deleteProjectGoal(projectId: string): void {
    if (!projectId) return;
    this.write('deleteProjectGoal', (db) => db.prepare('DELETE FROM project_goals WHERE project_id = ?').run(projectId), `goal:${projectId}`);
  }
}

function deserializeGraphNodeRow(row: Record<string, unknown>): ProjectGraphNode | null {
  try {
    const meta = JSON.parse(String(row.metadata_json || '{}'));
    return {
      id: String(row.id),
      projectId: String(row.projectId || row.project_id),
      kind: String(row.kind) as ProjectGraphNodeKind,
      name: String(row.name),
      path: row.path ? String(row.path) : undefined,
      metadata: meta && typeof meta === 'object' ? meta : undefined
    };
  } catch {
    return null;
  }
}

function deserializeGraphEdgeRow(row: Record<string, unknown>): ProjectGraphEdge | null {
  try {
    const meta = JSON.parse(String(row.metadata_json || '{}'));
    return {
      id: String(row.id),
      projectId: String(row.projectId || row.project_id),
      source: String(row.source || row.source_id),
      target: String(row.target || row.target_id),
      kind: String(row.kind) as ProjectGraphRelationKind,
      metadata: meta && typeof meta === 'object' ? meta : undefined
    };
  } catch {
    return null;
  }
}

function deserializeProjectRow(row: Record<string, unknown>): Project | null {
  try {
    const meta = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
    const health = JSON.parse(String(row.health_json || '{}'));
    return {
      id: String(row.id),
      name: String(row.name),
      rootPath: String(row.root_path),
      domainId: String(row.domain_id),
      secondaryDomains: Array.isArray(meta.secondaryDomains) ? meta.secondaryDomains as string[] : [],
      projectType: row.project_type as Project['projectType'],
      description: row.description ? String(row.description) : undefined,
      detectedLanguages: Array.isArray(meta.detectedLanguages) ? meta.detectedLanguages as Project['detectedLanguages'] : [],
      frameworks: Array.isArray(meta.frameworks) ? meta.frameworks as string[] : [],
      dependencies: Array.isArray(meta.dependencies) ? meta.dependencies as Project['dependencies'] : [],
      entryPoints: Array.isArray(meta.entryPoints) ? meta.entryPoints as string[] : [],
      importantFiles: Array.isArray(meta.importantFiles) ? meta.importantFiles as string[] : [],
      testSuites: Array.isArray(meta.testSuites) ? meta.testSuites as Project['testSuites'] : [],
      documentationFiles: Array.isArray(meta.documentationFiles) ? meta.documentationFiles as string[] : [],
      gitInfo: (meta.gitInfo && typeof meta.gitInfo === 'object') ? meta.gitInfo as Project['gitInfo'] : undefined,
      health: health && typeof health === 'object' ? health : { healthScore: 0 },
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      lastAnalyzedAt: Number(row.last_analyzed_at)
    };
  } catch {
    return null;
  }
}

/** Coerce an untrusted limit into [1, 1000] with a sane fallback. */
function clampLimit(n: number, fallback: number): number {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1000, v);
}
