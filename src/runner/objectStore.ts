/**
 * The runner's side of the content-addressed blob store (B2a Task 11).
 *
 * - Hash while writing: bytes are read once, hashed and written into `objects/tmp/<random>`, then renamed to
 *   `objects/<2>/<62>`. A rename onto an existing object of the same size is a no-op (the temporary file is removed).
 *   A rename refused with EPERM / EBUSY / EACCES (Windows: antivirus, an indexer) is retried 5 times with backoff, then
 *   the attempt's outputs fail `file_locked`.
 * - The GC lock contract (src/main/nexus/blobs/blobIndex.ts): an object never lands while GC deletes. Main enforces it
 *   for its own GC (no lease while GC holds the exclusive lock; GC refuses while any attempt is live, and the runner
 *   lands objects only for live attempts). The runner enforces it again for its own deletes: a landing holds this
 *   store SHARED; `gc.apply` takes it EXCLUSIVE, waits for landings in flight, and new landings wait for it.
 * - A source file is opened only after lstat says it is a regular file with one link, and its identity (device, inode,
 *   size) is checked again on the open handle: a swap between the check and the read is refused.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { ensureDirUnder, errCode, noLinkUnder, type HomePaths } from './paths';
import type { RunnerFs } from './types';

const CHUNK = 1 << 20;
export const RENAME_RETRIES = 5;
export const RENAME_BACKOFF_MS = 50;
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES']);

export class FileLockedError extends Error { constructor() { super('the output file is locked'); this.name = 'FileLockedError'; } }
export class SourceChangedError extends Error { constructor(why: string) { super(why); this.name = 'SourceChangedError'; } }

export interface HashedFile { sha256: string; bytes: number }

export class ObjectStore {
  private landing = 0;
  private gcActive = false;
  private waiters: (() => void)[] = [];

  constructor(private readonly paths: HomePaths, private readonly fs: RunnerFs, private readonly sleep: (ms: number) => Promise<void>) {}

  /** For tests: the lock's state. */
  get state(): { landing: number; gcActive: boolean } { return { landing: this.landing, gcActive: this.gcActive }; }

  private wake(): void { const w = this.waiters.splice(0); for (const f of w) f(); }
  private async wait(): Promise<void> { await new Promise<void>((res) => this.waiters.push(res)); }

  /** Run `fn` holding the store SHARED (a landing); waits while a GC holds it. */
  async withLanding<T>(fn: () => Promise<T>): Promise<T> {
    while (this.gcActive) await this.wait();
    this.landing++;
    try { return await fn(); } finally { this.landing--; this.wake(); }
  }

  /** Run `fn` holding the store EXCLUSIVE (a GC delete); waits for landings in flight and for another GC. */
  async withGc<T>(fn: () => Promise<T>): Promise<T> {
    while (this.gcActive || this.landing > 0) await this.wait();
    this.gcActive = true;
    try { return await fn(); } finally { this.gcActive = false; this.wake(); }
  }

  /**
   * Hash `src` while copying it into `objects/tmp`, then land it as `objects/<2>/<62>`. `expect` (a staged input)
   * refuses bytes that do not hash to it. Throws FileLockedError, SourceChangedError, or a file system error.
   */
  async ingestFile(src: string, o: { maxBytes?: number } = {}): Promise<HashedFile> {
    const tmpDir = this.paths.objectsTmpDir;
    if (!(await ensureDirUnder(this.fs, this.paths.root, tmpDir))) throw new Error('objects/tmp is not a plain folder');
    const tmp = path.join(tmpDir, `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}.part`);
    let hashed: HashedFile;
    try {
      hashed = await copyHashing(this.fs, src, tmp, o.maxBytes ?? Number.MAX_SAFE_INTEGER);
    } catch (e) {
      try { await this.fs.unlink(tmp); } catch { /* never created */ }
      throw e;
    }
    try {
      await this.land(tmp, hashed);
    } catch (e) {
      try { await this.fs.unlink(tmp); } catch { /* already gone */ }
      throw e;
    }
    return hashed;
  }

  /** Rename a hashed temporary file into place (a no-op onto an existing object of the same size). */
  async land(tmp: string, h: HashedFile): Promise<void> {
    await this.withLanding(async () => {
      const target = this.paths.objectPath(h.sha256);
      if (!(await ensureDirUnder(this.fs, this.paths.root, path.dirname(target)))) throw new Error('the object folder is not a plain folder');
      for (let k = 0; ; k++) {
        try {
          const st = await this.fs.lstat(target);
          if (st.isFile() && !st.isSymbolicLink() && st.size === h.bytes) { await this.fs.unlink(tmp); return; }
        } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
        try {
          await this.fs.rename(tmp, target);
          return;
        } catch (e) {
          if (!LOCKED.has(errCode(e))) throw e;
          if (k >= RENAME_RETRIES - 1) throw new FileLockedError();
          await this.sleep(RENAME_BACKOFF_MS * 2 ** k);
        }
      }
    });
  }

  /** Re-hash a stored object (`blob.verify`): false when it is missing, a link, or its bytes differ. */
  async verify(sha256: string): Promise<boolean> {
    let p: string;
    try { p = this.paths.objectPath(sha256); } catch { return false; }
    if (!(await noLinkUnder(this.fs, this.paths.root, p))) return false;
    try { return (await hashFile(this.fs, p)).sha256 === sha256; } catch { return false; }
  }

  /** `gc.apply`: delete exactly the listed objects, each only under `objects/`, under the exclusive lock. */
  async deleteObjects(shas: readonly string[]): Promise<{ removed: number; failed: number }> {
    return this.withGc(async () => {
      let removed = 0; let failed = 0;
      for (const sha of shas) {
        let p: string;
        try { p = this.paths.objectPath(sha); } catch { failed++; continue; }
        if (!(await noLinkUnder(this.fs, this.paths.root, p))) { failed++; continue; }
        try {
          const st = await this.fs.lstat(p);
          if (!st.isFile() || st.nlink > 1) { failed++; continue; }
          await this.fs.unlink(p); removed++;
        } catch (e) { if (errCode(e) !== 'ENOENT') failed++; }
      }
      return { removed, failed };
    });
  }
}

/** sha256 and size of a regular, single-link file (lstat first, identity re-checked on the open handle). */
export async function hashFile(fs: RunnerFs, p: string): Promise<HashedFile> {
  const st = await fs.lstat(p);
  if (!st.isFile() || st.isSymbolicLink()) throw new SourceChangedError('not a regular file');
  if (st.nlink > 1) throw new SourceChangedError('a hard link');
  const fh = await fs.open(p, 'r');
  try {
    const st2 = await fh.stat();
    if (st2.ino !== st.ino || st2.dev !== st.dev || st2.size !== st.size) throw new SourceChangedError('the file changed while it was opened');
    const h = createHash('sha256');
    const buf = Buffer.allocUnsafe(CHUNK);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) break;
      h.update(buf.subarray(0, bytesRead)); total += bytesRead;
    }
    return { sha256: h.digest('hex'), bytes: total };
  } finally { await fh.close(); }
}

/** Copy `src` into a new file `dst` (exclusive create) while hashing; refuses links and files that change while open. */
export async function copyHashing(fs: RunnerFs, src: string, dst: string, maxBytes: number): Promise<HashedFile> {
  const st = await fs.lstat(src);
  if (!st.isFile() || st.isSymbolicLink()) throw new SourceChangedError('not a regular file');
  if (st.nlink > 1) throw new SourceChangedError('a hard link');
  const fh = await fs.open(src, 'r');
  try {
    const st2 = await fh.stat();
    if (st2.ino !== st.ino || st2.dev !== st.dev || st2.size !== st.size) throw new SourceChangedError('the file changed while it was opened');
    const out = await fs.open(dst, 'wx');
    const h = createHash('sha256');
    let total = 0;
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new SourceChangedError('the file grew past its limit');
        h.update(buf.subarray(0, bytesRead));
        await out.write(buf, 0, bytesRead);
      }
    } finally { await out.close(); }
    if (total !== st.size) throw new SourceChangedError('the file changed size while it was read');
    return { sha256: h.digest('hex'), bytes: total };
  } finally { await fh.close(); }
}
