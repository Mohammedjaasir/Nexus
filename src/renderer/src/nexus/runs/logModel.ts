// Pure: a run log as readable lines. The runner writes one JSON frame per line
// (src/runner/logs.ts: `{"ts":<ms>,"stream":"stdout"|"stderr"|"nexus","text":"..."}`, plus one
// `"truncatedMiddle":true` marker frame when the middle was dropped); main answers whole frames, redacted again on
// read. Each frame becomes a time, a stream marker and its text, rendered as text only (never as HTML). A line that is
// not such a frame is shown as its own raw text, cut to RAW_LINE_CHARS, with a quiet marker.

export type LogStream = 'stdout' | 'stderr' | 'nexus';

export type LogLine =
  | { kind: 'frame'; time: string; stream: LogStream; marker: string; text: string; truncatedMiddle: boolean }
  | { kind: 'raw'; text: string; cut: boolean; marker: string };

/** How much of a line that is not a frame is shown. */
export const RAW_LINE_CHARS = 400;
/** The quiet marker on a line that is not a frame. */
export const RAW_MARKER = 'unreadable frame';

const STREAM_MARKER: Readonly<Record<LogStream, string>> = Object.freeze({ stdout: 'out', stderr: 'err', nexus: 'nexus' });

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** A frame time as local HH:MM:SS.mmm (a log reads in seconds; the date is the run's, shown elsewhere). */
export function logTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line of the log text as a frame, or as raw text when it is not one. */
export function logLine(line: string, fmt: (ts: number) => string = logTime): LogLine {
  let v: unknown = null;
  try { v = JSON.parse(line); } catch { v = null; }
  if (isObj(v) && typeof v.ts === 'number' && Number.isFinite(v.ts) && typeof v.text === 'string'
    && (v.stream === 'stdout' || v.stream === 'stderr' || v.stream === 'nexus')) {
    return { kind: 'frame', time: fmt(v.ts), stream: v.stream, marker: STREAM_MARKER[v.stream], text: v.text, truncatedMiddle: v.truncatedMiddle === true };
  }
  const cut = line.length > RAW_LINE_CHARS;
  return { kind: 'raw', text: cut ? `${line.slice(0, RAW_LINE_CHARS)}…` : line, cut, marker: RAW_MARKER };
}

/** The log text of one or more pages (whole frames, one per line) as lines; blank lines are dropped. */
export function logLines(text: string, fmt: (ts: number) => string = logTime): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') continue;
    out.push(logLine(line, fmt));
  }
  return out;
}
