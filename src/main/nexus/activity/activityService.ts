/**
 * The activity read API. Writes go through writer.ts only (inside each service's
 * own transaction); this service lists and verifies, always behind authorization.
 *
 * - A read filtered by project needs `activity.read` on that project; any other
 *   read (by session, by job, or unfiltered) needs it at platform scope, because a
 *   session or job id alone does not prove which project the caller may see.
 * - Results are newest first (`seq` descending), paged with `beforeSeq`, and
 *   capped at MAX_ACTIVITY_PAGE rows.
 */
import type Database from 'better-sqlite3';
import type { ActivityEntry, JobId, Principal, ProjectId, ScopeRef, SessionId } from '../../../shared/nexus/platform';
import type { AuthService } from '../auth/authService';
import { toEntry, verifyActivityChain, type ActivityDbRow } from './writer';

export const MAX_ACTIVITY_PAGE = 200;
export const DEFAULT_ACTIVITY_PAGE = 50;

export interface ActivityQuery { projectId?: ProjectId; sessionId?: SessionId; jobId?: JobId; beforeSeq?: number; limit?: number }

const PLATFORM: ScopeRef = { type: 'platform' };
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class ActivityService {
  constructor(private readonly db: Database.Database, private readonly deps: { auth: AuthService }) {}

  list(p: Principal, q: ActivityQuery): ActivityEntry[] {
    const query = q ?? {};
    const scope: ScopeRef = isStr(query.projectId) ? { type: 'project', projectId: query.projectId } : PLATFORM;
    this.deps.auth.require(p, 'activity.read', scope, { entityType: 'activity', details: { filter: describe(query) } });
    const where: string[] = []; const args: (string | number)[] = [];
    if (isStr(query.projectId)) { where.push('project_id = ?'); args.push(query.projectId); }
    if (isStr(query.sessionId)) { where.push('session_id = ?'); args.push(query.sessionId); }
    if (isStr(query.jobId)) { where.push('job_id = ?'); args.push(query.jobId); }
    if (typeof query.beforeSeq === 'number' && Number.isFinite(query.beforeSeq)) { where.push('seq < ?'); args.push(Math.floor(query.beforeSeq)); }
    const sql = `SELECT * FROM activity${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, pageSize(query.limit)) as ActivityDbRow[]).map(toEntry);
  }

  verifyChain(p: Principal): { ok: true; rows: number } | { ok: false; brokenAtSeq: number } {
    this.deps.auth.require(p, 'activity.read', PLATFORM, { entityType: 'activity', details: { op: 'verify_chain' } });
    return verifyActivityChain(this.db);
  }
}

function pageSize(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_ACTIVITY_PAGE;
  return Math.min(MAX_ACTIVITY_PAGE, Math.max(1, Math.floor(limit)));
}

/** Which filters were used (not their values), for a denial's audit row. */
function describe(q: ActivityQuery): string[] {
  return (['projectId', 'sessionId', 'jobId', 'beforeSeq', 'limit'] as const).filter((k) => q[k] !== undefined);
}
