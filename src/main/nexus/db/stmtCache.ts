/**
 * Prepared statements compiled once per connection (B2a stabilization A).
 *
 * `db.prepare(sql)` parses and plans the SQL every time: on the job read paths (exec.list, exec.get, a job's headline)
 * that cost more than running the query, and it ran once per listed job per query (about 140 compilations for one
 * list + get of 35 jobs). `cachedStmt(db, sql)` keeps the compiled statement per connection, keyed by its SQL text.
 *
 * Rules for callers: only fixed SQL text (or text built from a bounded set of shapes, such as an IN list of a known
 * length), and only `.get()`, `.all()` or `.run()` on the result: never `.iterate()` (it would leave the shared
 * statement busy) and never a mode switch (`.pluck()`, `.raw()`, `.expand()`, `.safeIntegers()`), which would change it
 * for every other caller. The cache is bounded; past the bound it starts over (the statements are finalized by GC).
 */
import type Database from 'better-sqlite3';

const MAX_STATEMENTS = 256;
const caches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function cachedStmt(db: Database.Database, sql: string): Database.Statement {
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  let st = cache.get(sql);
  if (!st) {
    if (cache.size >= MAX_STATEMENTS) cache.clear();
    st = db.prepare(sql);
    cache.set(sql, st);
  }
  return st;
}
