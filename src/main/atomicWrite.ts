import * as nodeFs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Atomic file replacement (O.9 #8). The data goes to a temp file in the SAME
 * directory (so the rename never crosses a volume), is fsynced, and is then
 * renamed over the target. A crash or a full disk mid-write leaves the old file
 * whole instead of a truncated config.json.
 *
 * Windows: a rename onto a file another process has open (an editor, an AV
 * scanner, a sync client) fails with EPERM/EBUSY/EACCES for a moment, so those
 * are retried 5 times, 50 ms apart. If the rename still fails, the temp file is
 * removed and the error is thrown; the target is untouched.
 */

/** The fs surface writeFileAtomic uses (injectable for tests). */
export type AtomicFs = Pick<typeof nodeFs, 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'rmSync'>;

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 5;
const RETRY_DELAY_MS = 50;

function sleepSync(ms: number): void {
  // Synchronous on purpose: config writes are synchronous everywhere they are
  // called. Atomics.wait on a private buffer blocks without spinning the CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomic(path: string, data: string, fsImpl: AtomicFs = nodeFs, opts: { mode?: number } = {}): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = fsImpl.openSync(tmp, 'w', opts.mode ?? 0o666);
    const buf = Buffer.from(data, 'utf8');
    let off = 0;
    while (off < buf.length) off += fsImpl.writeSync(fd, buf, off, buf.length - off);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    for (let attempt = 0; ; attempt++) {
      try {
        fsImpl.renameSync(tmp, path);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (!code || !RETRY_CODES.has(code) || attempt >= RETRIES) throw e;
        sleepSync(RETRY_DELAY_MS);
      }
    }
  } catch (e) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* already closed */ } }
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw e;
  }
}
