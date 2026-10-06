/**
 * Principal resolution. The main process is the only place identity comes from:
 * the renderer never supplies a principal id, kind or name. Phase 1 has one
 * seeded local owner ('user:local') and the platform's own 'system' principal;
 * multi-user later adds rows to `principals`, not schema.
 */
import type Database from 'better-sqlite3';
import type { Principal, PrincipalId, PrincipalKind } from '../../../shared/nexus/platform';
import { PlatformError } from '../errors';

export const LOCAL_USER_ID = 'user:local';
export const SYSTEM_ID = 'system';

interface PrincipalRow { id: string; kind: PrincipalKind; display_name: string; disabled_at: number | null }

export class PrincipalResolver {
  constructor(private readonly db: Database.Database) {}

  /** The seeded local owner. Disabled or not, it is returned; authorization decides. */
  localUser(): Principal { return this.seeded(LOCAL_USER_ID); }

  /** The platform's own principal, used for recovery and system-only transitions. */
  system(): Principal { return this.seeded(SYSTEM_ID); }

  get(id: PrincipalId): (Principal & { disabledAt: number | null }) | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    const r = this.db.prepare('SELECT id, kind, display_name, disabled_at FROM principals WHERE id = ?').get(id) as PrincipalRow | undefined;
    return r ? { id: r.id, kind: r.kind, displayName: r.display_name, disabledAt: r.disabled_at } : null;
  }

  private seeded(id: string): Principal {
    const r = this.get(id);
    if (!r) throw new PlatformError('platform_unavailable', `seeded principal missing: ${id}`);
    return { id: r.id, kind: r.kind, displayName: r.displayName };
  }
}
