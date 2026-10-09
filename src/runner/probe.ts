/**
 * The dev deployment health probe (B2a Task 11): one HTTP GET to 127.0.0.1 only (the forwarder's loopback port), a
 * 2 s timeout, the status and the latency. The body is never stored: at most 1 MiB of it is read and only its sha256
 * is kept. No redirect is followed, no proxy is used, nothing but the loopback address is ever contacted.
 */
import { createHash } from 'node:crypto';
import * as http from 'node:http';

export const PROBE_TIMEOUT_MS = 2_000;
export const PROBE_BODY_MAX = 2 ** 20;
const PATH_RE = /^\/[A-Za-z0-9/_.-]{0,200}$/;

export interface ProbeResult { status: number | null; ms: number | null; bodySha256?: string }

export type HttpProbe = (port: number, path: string) => Promise<ProbeResult>;

export const httpProbe: HttpProbe = (port, path) => new Promise((resolve) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof path !== 'string' || !PATH_RE.test(path)) {
    resolve({ status: null, ms: null }); return;
  }
  const t0 = process.hrtime.bigint();
  let done = false;
  const finish = (r: ProbeResult): void => { if (!done) { done = true; resolve(r); } };
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', agent: false, timeout: PROBE_TIMEOUT_MS,
    headers: { connection: 'close', 'user-agent': 'nexus-probe' } }, (res) => {
    const h = createHash('sha256');
    let read = 0;
    res.on('data', (d: Buffer) => {
      if (read >= PROBE_BODY_MAX) return;
      const part = d.subarray(0, PROBE_BODY_MAX - read);
      h.update(part); read += part.length;
      if (read >= PROBE_BODY_MAX) res.destroy();
    });
    const end = (): void => {
      if (done) return;
      const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
      const status = typeof res.statusCode === 'number' && res.statusCode >= 100 && res.statusCode <= 599 ? res.statusCode : null;
      finish({ status, ms, bodySha256: h.digest('hex') });
    };
    res.on('end', end);
    res.on('close', end);
    res.on('error', () => finish({ status: null, ms: null }));
  });
  req.on('timeout', () => { req.destroy(); finish({ status: null, ms: null }); });
  req.on('error', () => finish({ status: null, ms: null }));
  req.end();
});
