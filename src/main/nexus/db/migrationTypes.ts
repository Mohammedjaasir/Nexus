import type Database from 'better-sqlite3';
import type { BackupRecord } from './backup';

/** Test seams around the v7 transaction. Production code never sets these. */
export interface MigrationHooks {
  /** Runs inside the v7 transaction after every write and `user_version = 7`, just before COMMIT. */
  beforeCommit?: (db: Database.Database, toVersion: number) => void;
  /** Runs just before the v7 transaction begins (the crash test lowers cache_size here). */
  beforeTransaction?: (db: Database.Database) => void;
  /** Replaces the free-space probe of the backup directory (insufficient_disk test). */
  freeBytes?: () => number | null;
}

export interface MigrationContext {
  now: () => number;
  appVersion: string | null;
  /** The version the database had when it was opened (0 for a fresh file). */
  fromVersion: number;
  /** Row count of every user table before anything changed; null for a fresh DB. */
  preCounts: Record<string, number> | null;
  /** The verified pre-migration backup; null for a fresh DB. */
  backup: BackupRecord | null;
}

export type MigrationOutcome =
  | { state: 'not_needed'; version: number }
  | { state: 'applied'; fromVersion: number; backupFile: string | null; durationMs: number; backfilled: number; unassigned: number; postCheckOk: boolean }
  | { state: 'skipped'; fromVersion: number; reason: 'held' | 'precheck_failed' | 'insufficient_disk' | 'backup_failed' | 'newer_schema'; detail: string }
  | { state: 'failed'; fromVersion: number; error: string; backupFile: string | null };
