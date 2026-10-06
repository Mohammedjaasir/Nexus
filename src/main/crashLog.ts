/**
 * Main-process crash log (O.9 #20). Uncaught exceptions and unhandled
 * rejections are appended to `<dir>/main.log` with a size-capped rotation
 * (main.log -> main.1.log -> main.2.log). Nothing here may throw: a failure to
 * write the log must never become a second crash.
 *
 * Self-contained on purpose (no electron / hive imports) so it loads in plain
 * node tests. The redaction mirrors the credential shapes of hive.redactSecrets
 * and adds Groq (`gsk_`), Authorization headers and the per-agent hex tokens.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

const MAX_ENTRY_CHARS = 16_000;

/** Strip known secret shapes from text destined for the log. Never throws. */
export function redactForLog(text: string): string {
  try {
    let s = text;
    s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]');
    s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
    s = s.replace(
      /(?:\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|xox[bpaors]-[A-Za-z0-9-]{6,}|xapp-[A-Za-z0-9-]{6,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
      '[redacted]'
    );
    s = s.replace(/\b(bearer|basic)\s+[^\s"',;]+/gi, '$1 [redacted]');
    s = s.replace(/\b(authorization|x-api-key|x-auth-token)(\s*[:=]\s*)[^\r\n]+/gi, '$1$2[redacted]');
    // scheme://user:pass@host -> scheme://[redacted]@host
    s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, '$1[redacted]@');
    // Chat webhook URLs carry their secret in the path.
    s = s.replace(/https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[^\s"'<>]+/gi, '[redacted]');
    s = s.replace(/https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/[^\s"'<>]+/gi, '[redacted]');
    s = s.replace(/https?:\/\/api\.telegram\.org\/(?:file\/)?bot[^\s"'<>/]+/gi, 'https://api.telegram.org/bot[redacted]');
    // Per-agent hook/telemetry tokens are 32 random bytes as hex.
    s = s.replace(/\b[a-f0-9]{48,}\b/gi, '[redacted]');
    // Sensitive key = value, key: value and JSON "key": "value", any value length.
    s = s.replace(
      /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(["']?)(\s*[:=]\s*)(?:(["'])(?:\\.|(?!\4)[^\\])*\4|[^\s"',}&]+)/gi,
      (_m, k, q, sep, vq) => `${k}${q}${sep}${vq ? `${vq}[redacted]${vq}` : '[redacted]'}`
    );
    return s;
  } catch {
    return '[unredactable entry omitted]';
  }
}

function describe(err: unknown): string {
  try {
    if (err instanceof Error) return err.stack || `${err.name}: ${err.message}`;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      try { return JSON.stringify(err); } catch { return Object.prototype.toString.call(err); }
    }
    return String(err);
  } catch {
    return '[unprintable error]';
  }
}

/** `<ISO time> <kind> <stack or message>`, redacted and length-capped. */
export function formatCrash(kind: CrashKind, err: unknown, now: Date): string {
  let stamp: string;
  try { stamp = now.toISOString(); } catch { stamp = 'unknown-time'; }
  let body = redactForLog(describe(err));
  if (body.length > MAX_ENTRY_CHARS) body = `${body.slice(0, MAX_ENTRY_CHARS)}... [truncated]`;
  return `${stamp} ${kind} ${body}`;
}

function rotate(dir: string, keep: number): void {
  const name = (i: number): string => join(dir, i === 0 ? 'main.log' : `main.${i}.log`);
  try { rmSync(name(keep - 1), { force: true }); } catch { /* best effort */ }
  for (let i = keep - 2; i >= 0; i--) {
    try { if (existsSync(name(i))) renameSync(name(i), name(i + 1)); } catch { /* best effort */ }
  }
}

/** Append one entry to `<dir>/main.log`, rotating when it would exceed
 *  `maxBytes` (default 5 MB) and keeping `keep` files (default 3). Never throws. */
export function appendCrashLog(dir: string, line: string, opts: { maxBytes?: number; keep?: number } = {}): void {
  try {
    const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    const keep = Math.max(1, opts.keep ?? 3);
    const entry = line.endsWith('\n') ? line : `${line}\n`;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'main.log');
    let size = 0;
    try { size = statSync(file).size; } catch { /* not there yet */ }
    if (size > 0 && size + Buffer.byteLength(entry) > maxBytes) rotate(dir, keep);
    appendFileSync(file, entry, 'utf8');
  } catch {
    /* the crash log must never crash the process */
  }
}
