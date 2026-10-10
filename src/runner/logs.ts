/**
 * Attempt and image-build logs (B2a Task 11): one JSON frame per line, `{"ts":<ms>,"stream":"stdout"|"stderr"|"nexus",
 * "text":"..."}`, every text redacted on write with `redactSecretText` (main's redactor: provider keys, bearer tokens,
 * URL credentials, private keys, key=value secrets). A log is capped (50 MiB): once the head is full, ONE marker frame
 * (`"truncatedMiddle":true`) is written and the newest frames are kept in a bounded tail that is appended when the log
 * closes, so the middle is dropped, never the start or the end. Writes are serialized and never block the loop.
 */
import * as path from 'node:path';
import { redactSecretText } from '../main/nexus/activity/redact';
import { ensureDirUnder } from './paths';
import type { RunnerFs } from './types';

export const LOG_CAP_BYTES = 50 * 2 ** 20;
export const MAX_LINE_CHARS = 16_384;
/** What an over-long unterminated line keeps back when it is flushed early (longer than any credential shape). */
export const OVERLAP_CHARS = 512;
export const TRUNCATED_TEXT = '[output truncated: the middle of the output was dropped]';

type Stream = 'stdout' | 'stderr' | 'nexus';
type FileHandle = Awaited<ReturnType<RunnerFs['open']>>;

export class LogWriter {
  private fh: FileHandle | null = null;
  private written = 0;
  private truncated = false;
  private readonly tail: string[] = [];
  private tailBytes = 0;
  private readonly partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly headLimit: number;
  private readonly tailLimit: number;

  constructor(private readonly fs: RunnerFs, private readonly root: string, readonly file: string,
    private readonly o: { capBytes?: number; now: () => number }) {
    const cap = Math.max(4096, o.capBytes ?? LOG_CAP_BYTES);
    this.tailLimit = Math.floor(cap / 5);
    this.headLimit = cap - this.tailLimit - 256;
  }

  /** Opens (appending: an adopted attempt continues its log). Throws when the folder is refused. */
  async open(): Promise<void> {
    if (!(await ensureDirUnder(this.fs, this.root, path.dirname(this.file)))) throw new Error('the log folder is not a plain folder');
    this.fh = await this.fs.open(this.file, 'a');
    try { this.written = (await this.fh.stat()).size; } catch { this.written = 0; }
    if (this.written >= this.headLimit) this.truncated = true;
  }

  /** Stored bytes so far (what a reader can read). */
  bytes(): number { return this.written; }
  get truncatedMiddle(): boolean { return this.truncated; }

  /**
   * A chunk of container output: split into lines; a partial line waits for its end (or close). An unterminated line
   * that grows past MAX_LINE_CHARS is flushed only up to its last separator (else all but the last OVERLAP_CHARS), so
   * the token being written stays whole in the buffer and is redacted once it is complete: a key is never split
   * before redaction.
   */
  write(stream: 'stdout' | 'stderr', chunk: string): void {
    if (this.closed) return;
    const text = this.partial[stream] + chunk;
    const lines = text.split('\n');
    this.partial[stream] = lines.pop() ?? '';
    for (const l of lines) this.frame(stream, l.endsWith('\r') ? l.slice(0, -1) : l);
    while (this.partial[stream].length > MAX_LINE_CHARS) {
      // Keep at least the last OVERLAP_CHARS back (a phrase like `Authorization: Bearer <value>` stays together), and cut
      // at the last separator before that point when there is one.
      const p = this.partial[stream];
      const limit = p.length - OVERLAP_CHARS;
      const sep = Math.max(p.lastIndexOf(' ', limit), p.lastIndexOf('\t', limit));
      const cut = sep > 0 ? sep : limit;
      this.frame(stream, p.slice(0, cut));
      this.partial[stream] = p.slice(cut);
    }
  }

  /** A line written by the runner itself (redacted like any other). */
  nexus(text: string): void { if (!this.closed) this.frame('nexus', text); }

  /** One logical line: redacted WHOLE first, then cut into frames (a secret never straddles a frame unredacted). */
  private frame(stream: Stream, line: string): void {
    const clean = redactSecretText(line);
    const MARK = '[redacted]';
    let i = 0;
    do {
      let cut = Math.min(clean.length, i + MAX_LINE_CHARS);
      // A cut never splits a redaction marker (a reader always sees `[redacted]` whole).
      const m = clean.lastIndexOf(MARK, cut - 1);
      if (cut < clean.length && m > i && m < cut && m + MARK.length > cut) cut = m;
      const s = `${JSON.stringify({ ts: this.o.now(), stream, text: clean.slice(i, cut) })}\n`;
      this.enqueue(s);
      i = cut;
    } while (i < clean.length);
  }

  private enqueue(s: string): void {
    const n = Buffer.byteLength(s);
    if (!this.truncated && this.written + n <= this.headLimit) {
      this.written += n;
      this.append(s);
      return;
    }
    if (!this.truncated) {
      this.truncated = true;
      const marker = `${JSON.stringify({ ts: this.o.now(), stream: 'nexus', text: TRUNCATED_TEXT, truncatedMiddle: true })}\n`;
      this.written += Buffer.byteLength(marker);
      this.append(marker);
    }
    this.tail.push(s); this.tailBytes += n;
    while (this.tailBytes > this.tailLimit && this.tail.length > 0) this.tailBytes -= Buffer.byteLength(this.tail.shift()!);
  }

  private append(s: string): void {
    const fh = this.fh;
    if (!fh) return;
    this.chain = this.chain.then(() => fh.write(s).then(() => undefined), () => undefined).catch(() => undefined);
  }

  /** Writes what is pending (partial lines, the kept tail) and closes the file. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) { await this.chain; return; }
    for (const st of ['stdout', 'stderr'] as const) if (this.partial[st]) { this.frame(st, this.partial[st]); this.partial[st] = ''; }
    this.closed = true;
    if (this.truncated && this.tail.length > 0) {
      const t = this.tail.splice(0).join('');
      this.written += Buffer.byteLength(t); this.tailBytes = 0;
      this.append(t);
    }
    await this.chain;
    const fh = this.fh; this.fh = null;
    if (fh) { try { await fh.close(); } catch { /* already closed */ } }
  }

  /** Waits for the writes queued so far (tests). */
  flushed(): Promise<void> { return this.chain; }
}
