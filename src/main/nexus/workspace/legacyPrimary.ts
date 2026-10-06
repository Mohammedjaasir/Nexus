/**
 * Keeps a project's PRIMARY participation in step with its legacy `domain_id`.
 *
 * This is the live rule. It mirrors backfillProjectWorkspacesV7 (schemaV7.ts) but
 * maps through the live catalogue (shared/nexus/workspaceCatalog.ts), which a test
 * pins to the frozen v7 mapping, so the backfill and this rule agree.
 *
 *   mapped domain   -> the (project, workspace) row is active with is_primary = 1
 *                      (inserted with source 'legacy_domain' when missing; a
 *                      'backfill' row keeps its source); every other row of the
 *                      project is cleared to is_primary = 0 FIRST, so the one-primary
 *                      unique index never sees two.
 *   unmapped domain -> every row of the project gets is_primary = 0. Rows are kept:
 *                      participation is history, the domain only names the primary.
 *   complete target -> the sync NEVER changes a 'complete' row: not its status and
 *                      not its completion_* evidence. The v7 DDL forbids a non-active
 *                      primary (CHECK (is_primary = 0 OR status = 'active')), and
 *                      AuthService and later services assume the primary is active,
 *                      so the project is left with NO primary: the other rows are
 *                      cleared as usual, a line is logged, and the result is
 *                      'complete_target'. (An activity row is written only when a
 *                      previous primary was cleared.)
 *
 * One activity row (actor system, action 'project_workspace.primary_synced') is
 * written when something changed. The function never opens a transaction of its
 * own: callers run it inside theirs (saveProjectNow uses a caught savepoint, the
 * reconcile an IMMEDIATE transaction), so the activity row commits or rolls back
 * with the change it records.
 */
import type Database from 'better-sqlite3';
import type { ProjectId } from '../../../shared/nexus/platform';
import { workspaceForLegacyDomain } from '../../../shared/nexus/workspaceCatalog';
import { appendActivityRow } from '../activity/writer';
import { newId } from '../db/ids';

export type SyncResult = 'unchanged' | 'set' | 'cleared' | 'complete_target';

export const PRIMARY_SYNCED_ACTION = 'project_workspace.primary_synced';

interface PwRow { id: string; workspace_id: string; status: string; is_primary: number; source: string }

export function syncPrimaryFromLegacyDomain(db: Database.Database, projectId: ProjectId, domainId: string | null, now: number,
  log?: (line: string) => void): SyncResult {
  if (!db.inTransaction) throw new Error('syncPrimaryFromLegacyDomain must run inside the caller\'s transaction');
  const ws = workspaceForLegacyDomain(domainId);
  const rows = db.prepare('SELECT id, workspace_id, status, is_primary, source FROM project_workspaces WHERE project_id = ?')
    .all(projectId) as PwRow[];
  const primaries = rows.filter((r) => r.is_primary === 1);
  let result: SyncResult;
  let participationId: string | null = null;

  if (ws === null) {
    if (primaries.length === 0) return 'unchanged';
    db.prepare('UPDATE project_workspaces SET is_primary = 0, updated_at = ? WHERE project_id = ? AND is_primary = 1').run(now, projectId);
    result = 'cleared';
  } else {
    const target = rows.find((r) => r.workspace_id === ws) ?? null;
    if (target && target.status === 'complete') {
      // A complete participation is never touched; it cannot be the primary either (see the header).
      const cleared = db.prepare('UPDATE project_workspaces SET is_primary = 0, updated_at = ? WHERE project_id = ? AND is_primary = 1')
        .run(now, projectId).changes;
      try { log?.(`[nexus] primary sync: project=${String(projectId).slice(0, 128)} maps to workspace=${ws} whose participation is complete; left without a primary`); } catch { /* logging never breaks a sync */ }
      if (cleared > 0) {
        appendActivityRow(db, {
          actorKind: 'system', actorId: 'system', projectId, workspaceId: ws, entityType: 'project_workspace', entityId: target.id,
          action: PRIMARY_SYNCED_ACTION, status: 'succeeded', details: { workspaceId: null, result: 'complete_target' }
        }, now);
      }
      return 'complete_target';
    }
    if (target && target.is_primary === 1 && target.status === 'active' && primaries.length === 1) return 'unchanged';
    db.prepare('UPDATE project_workspaces SET is_primary = 0, updated_at = ? WHERE project_id = ? AND is_primary = 1 AND workspace_id <> ?')
      .run(now, projectId, ws);
    if (target) {
      db.prepare(`UPDATE project_workspaces SET status = 'active', is_primary = 1,
          source = CASE WHEN source = 'backfill' THEN 'backfill' ELSE 'legacy_domain' END, updated_at = ?
        WHERE id = ?`).run(now, target.id);
      participationId = target.id;
    } else {
      participationId = newId(now);
      db.prepare(`INSERT INTO project_workspaces (id, project_id, workspace_id, objective, status, is_primary, source,
          completion_json, completion_hash, completion_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, NULL, 'active', 1, 'legacy_domain', NULL, NULL, NULL, 'system', ?, ?)`).run(participationId, projectId, ws, now, now);
    }
    result = 'set';
  }

  appendActivityRow(db, {
    actorKind: 'system', actorId: 'system', projectId, workspaceId: ws,
    entityType: 'project_workspace', entityId: participationId ?? projectId,
    action: PRIMARY_SYNCED_ACTION, status: 'succeeded', details: { workspaceId: ws, result }
  }, now);
  return result;
}
