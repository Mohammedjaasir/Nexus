/**
 * The Nexus platform composition root. It wires the core services onto the one
 * better-sqlite3 connection that PersistStore opened at schema v7. It grows task by
 * task (jobs and sessions join later); for now it holds principal resolution,
 * authorization, the activity read API, workspaces and project participation,
 * project-scoped access checks, artifacts with their versions, and the
 * version-level lineage DAG.
 *
 * No IPC is registered here. Callers in main pass a Principal resolved through
 * `principals`; the renderer never supplies identity.
 */
import type Database from 'better-sqlite3';
import { ActivityService } from './activity/activityService';
import { ArtifactService } from './artifact/artifactService';
import { AuthService } from './auth/authService';
import { PrincipalResolver } from './auth/principals';
import { LineageService } from './lineage/lineageService';
import { ProjectAccess } from './project/projectAccess';
import { WorkspaceService } from './workspace/workspaceService';

export interface NexusPlatform {
  principals: PrincipalResolver;
  auth: AuthService;
  activity: ActivityService;
  workspaces: WorkspaceService;
  projects: ProjectAccess;
  artifacts: ArtifactService;
  lineage: LineageService;
  startup(): void;
}

export function createNexusPlatform(db: Database.Database, opts?: { now?: () => number; log?: (line: string) => void }): NexusPlatform {
  const now = opts?.now ?? Date.now;
  const log = opts?.log ?? (() => {});
  const principals = new PrincipalResolver(db);
  const auth = new AuthService(db, { now, log });
  const activity = new ActivityService(db, { auth });
  const workspaces = new WorkspaceService(db, { auth, now, log });
  const projects = new ProjectAccess(db, { auth });
  const artifacts = new ArtifactService(db, { auth, now });
  const lineage = new LineageService(db, { auth, now });
  return {
    principals, auth, activity, workspaces, projects, artifacts, lineage,
    startup() {
      // The seeded principals must resolve; a missing one throws platform_unavailable.
      principals.localUser();
      const system = principals.system();
      const added = workspaces.ensureCatalog(system);
      // Repairs a primary whose in-save sync failed and rows written by an older build.
      const r = workspaces.reconcileLegacyPrimaries(system);
      log(`[nexus] platform ready: principals ok, workspaces added=${added}, primaries set=${r.set} cleared=${r.cleared}`);
    }
  };
}
