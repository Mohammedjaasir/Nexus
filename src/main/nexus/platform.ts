/**
 * The Nexus platform composition root. It wires the core services onto the one
 * better-sqlite3 connection that PersistStore opened at schema v7. It grows task by
 * task; it holds principal resolution, authorization, the activity read API,
 * workspaces and project participation, project-scoped access checks, artifacts
 * with their versions, the version-level lineage DAG, durable jobs and agent
 * sessions. Nothing here executes work: there is no executor, scheduler or runtime.
 *
 * No IPC is registered here. Callers in main pass a Principal resolved through
 * `principals`; the renderer never supplies identity.
 */
import type Database from 'better-sqlite3';
import { ActivityService } from './activity/activityService';
import { ArtifactService } from './artifact/artifactService';
import { AuthService } from './auth/authService';
import { JobService } from './jobs/jobService';
import { PrincipalResolver } from './auth/principals';
import { LineageService } from './lineage/lineageService';
import { ProjectAccess } from './project/projectAccess';
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
  /** True when the store is at v8 with its shape checked; the handoff service arrives with it (Task 4). */
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
  const handoffsAvailable = opts?.handoffs === true;
  const log = opts?.log ?? (() => {});
  const principals = new PrincipalResolver(db);
  const auth = new AuthService(db, { now, log });
  const activity = new ActivityService(db, { auth });
  const workspaces = new WorkspaceService(db, { auth, now, log });
  const projects = new ProjectAccess(db, { auth });
  const artifacts = new ArtifactService(db, { auth, now });
  const lineage = new LineageService(db, { auth, now });
  const jobs = new JobService(db, { auth, now });
  const sessions = new SessionService(db, { auth, jobs, now });
  return {
    principals, auth, activity, workspaces, projects, artifacts, lineage, jobs, sessions, handoffsAvailable,
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
