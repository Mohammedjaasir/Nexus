/**
 * Shared IMMEDIATE-transaction runner for the platform services.
 *
 * `immediateTx(db, fn)` runs `fn` in `db.transaction(fn).immediate()`. Inside a
 * caller's transaction, better-sqlite3 turns this into a savepoint. When SQLite
 * cannot take or keep the lock (SQLITE_BUSY*, SQLITE_LOCKED*: another writer held
 * it past busy_timeout), the raw SqliteError becomes PlatformError
 * 'platform_unavailable', so callers see one stable code for "try again later".
 * Every other error is rethrown unchanged. The transaction has rolled back either way.
 */
import type Database from 'better-sqlite3';
import { PlatformError } from '../errors';

export function isSqliteBusy(e: unknown): boolean {
  if (e instanceof PlatformError) return false;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code);
}

export function immediateTx<T>(db: Database.Database, fn: () => T): T {
  try {
    return db.transaction(fn).immediate();
  } catch (e) {
    if (isSqliteBusy(e)) {
      throw new PlatformError('platform_unavailable', 'the database is busy; try again', { sqliteCode: (e as { code: string }).code });
    }
    throw e;
  }
}
