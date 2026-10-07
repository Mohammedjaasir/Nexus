/**
 * The Nexus platform composition root. It wires the core services onto the one
 * better-sqlite3 connection that PersistStore opened at schema v7. It grows task by
 * task; it holds principal resolution, authorization, the activity read API,
 * workspaces and project participation, project-scoped access checks, artifacts
 * with their versions, the version-level lineage DAG, durable jobs, agent
 * sessions and, at schema v8, handoffs (null below v8 or when v8 is held or
 * failed). Nothing here executes work: there is no executor, scheduler or runtime.
 *
 * No IPC is registered here. Callers in main pass a Principal resolved through
 * `principals`; the renderer never supplies identity.
 */
import type Database from 'better-sqlite3';
import { ActivityService } from './activity/activityService';
import { ArtifactService } from './artifact/artifactService';
import { AuthService } from './auth/authService';
import { HandoffService } from './handoff/handoffService';
import { JobService } from './jobs/jobService';
import { PrincipalResolver } from './auth/principals';
import { LineageService } from './lineage/lineageService';
import { ProjectAccess } from './project/projectAccess';
import { v8ShapeProblem } from './db/schemaV8';
import { SessionService } from './sessions/sessionService';
import { WorkspaceService } from './workspace/workspaceService';

export interface NexusPlatform {
  principals: PrincipalResolver;
  auth: AuthService;
  activity: ActivityService;
  workspaces: WorkspaceService;
  projects: ProjectAccess;
  artifacts: ArtifactService;
  lineage: LineageService;
  jobs: JobService;
  sessions: SessionService;
  /** Handoffs between participations (schema v8); null when v8 is held, failed or not in place. */
  handoffs: HandoffService | null;
  /** True exactly when `handoffs` is built: the store is at v8 with its shape checked. */
  handoffsAvailable: boolean;
  startup(): NexusStartupReport;
}

/** What one startup pass did; every count is 0 on a clean restart. */
export interface NexusStartupReport {
  catalogAdded: number;
  primaries: { set: number; cleared: number };
  sessions: { interrupted: number };
  jobs: { interrupted: number; requeued: number };
}

export function createNexusPlatform(db: Database.Database, opts?: { now?: () => number; log?: (line: string) => void; handoffs?: boolean }): NexusPlatform {
  const now = opts?.now ?? Date.now;
  const log = opts?.log ?? (() => {});
  // The caller (main) says whether v8 is in place; without that, the v8 shape decides.
  const handoffsOn = opts?.handoffs ?? (v8ShapeProblem(db, true) === null);
  const principals = new PrincipalResolver(db);
  const auth = new AuthService(db, { now, log });
  const activity = new ActivityService(db, { auth });
  // Late-bound: the withdraw guard counts open handoffs once the handoff service exists (never below v8).
  let handoffs: HandoffService | null = null;
  const workspaces = new WorkspaceService(db, { auth, now, log, openHandoffs: (id) => handoffs?.openCountFor(id) ?? 0 });
  const projects = new ProjectAccess(db, { auth });
  const artifacts = new ArtifactService(db, { auth, now });
  const lineage = new LineageService(db, { auth, now });
  const jobs = new JobService(db, { auth, now });
  const sessions = new SessionService(db, { auth, jobs, now });
  if (handoffsOn) handoffs = new HandoffService(db, { auth, principals, artifacts, now });
  else log('[nexus] handoffs unavailable: schema v8 not in place');
  const handoffsAvailable = handoffs !== null;
  return {
    principals, auth, activity, workspaces, projects, artifacts, lineage, jobs, sessions, handoffs, handoffsAvailable,
    startup(): NexusStartupReport {
      // The seeded principals must resolve; a missing one throws platform_unavailable.
      principals.localUser();
      const system = principals.system();
      const added = workspaces.ensureCatalog(system);
      // Repairs a primary whose in-save sync failed and rows written by an older build.
      const r = workspaces.reconcileLegacyPrimaries(system);
      // Nothing executes across a restart: sessions first, then their jobs.
      const s = sessions.recoverAfterRestart(system);
      const j = jobs.recoverAfterRestart(system);
      log(`[nexus] platform ready: principals ok, workspaces added=${added}, primaries set=${r.set} cleared=${r.cleared}, `
        + `sessions interrupted=${s.interrupted}, jobs interrupted=${j.interrupted} requeued=${j.requeued}`);
      return {
        catalogAdded: added,
        primaries: { set: r.set, cleared: r.cleared },
        sessions: { interrupted: s.interrupted },
        jobs: { interrupted: j.interrupted, requeued: j.requeued }
      };
    }
  };
}
