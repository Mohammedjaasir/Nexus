/**
 * The Nexus platform composition root. It wires the core services onto the one
 * better-sqlite3 connection that PersistStore opened at schema v7. It grows task by
 * task (workspaces, artifacts, lineage, jobs and sessions join later); for now it
 * holds principal resolution, authorization and the activity read API.
 *
 * No IPC is registered here. Callers in main pass a Principal resolved through
 * `principals`; the renderer never supplies identity.
 */
import type Database from 'better-sqlite3';
import { ActivityService } from './activity/activityService';
import { AuthService } from './auth/authService';
import { PrincipalResolver } from './auth/principals';

export interface NexusPlatform {
  principals: PrincipalResolver;
  auth: AuthService;
  activity: ActivityService;
  startup(): void;
}

export function createNexusPlatform(db: Database.Database, opts?: { now?: () => number; log?: (line: string) => void }): NexusPlatform {
  const now = opts?.now ?? Date.now;
  const log = opts?.log ?? (() => {});
  const principals = new PrincipalResolver(db);
  const auth = new AuthService(db, { now, log });
  const activity = new ActivityService(db, { auth });
  return {
    principals, auth, activity,
    startup() {
      // The seeded principals must resolve; a missing one throws platform_unavailable.
      principals.localUser(); principals.system();
      log('[nexus] platform ready: principals ok');
    }
  };
}
