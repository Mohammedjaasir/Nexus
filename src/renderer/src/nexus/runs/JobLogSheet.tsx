import { useEffect, useRef, useState } from 'react';
import { nexusClient } from '../data/nexusClient';
import { execFailText } from '../data/errorCopy';
import { useJob } from '../data/useExecution';
import { rangeAttempt, type LogRange } from '../project/evidenceModel';
import { Sheet } from '../ui/Sheet';
import { Button } from '../ui/Button';
import { jobTitle } from './jobRunModel';

/** One read of the log: main answers whole frames, redacted again on read, at most this many bytes. */
export const LOG_PAGE_BYTES = 64 * 1024;

/** The paged, redacted log of one attempt of a job. "Load more" reads on from the byte offset main returned; a log
 *  range from the evidence opens at its own offset. */
export function JobLogSheet({ jobId, range, onClose }: { jobId: string; range?: LogRange | null; onClose: () => void }) {
  return (
    <Sheet open onClose={onClose} labelledBy="nx-xl-title" focusHeading>
      <LogBody jobId={jobId} range={range ?? null} onClose={onClose} />
    </Sheet>
  );
}

type Page = { text: string; nextOffset: number; eof: boolean; truncatedMiddle: boolean };

function LogBody({ jobId, range, onClose }: { jobId: string; range: LogRange | null; onClose: () => void }) {
  const job = useJob(jobId);
  const history = job.data?.attemptHistory ?? [];
  const attempts = history.map((a) => a.n);
  // The range's attempt: its number, else the attempt whose id the report names (exact for a job with several).
  const target = range ? rangeAttempt(range, history) : null;
  const [attempt, setAttempt] = useState<number | null>(null);
  const shown = attempt ?? target ?? (attempts.length ? attempts[attempts.length - 1] : null);
  // The range's offset applies only to its own attempt; while the attempt is not known yet, nothing is read.
  const resolving = !!range && target === null && range.attemptId !== null && !job.loaded;
  const start = range && target !== null && target === shown ? range.offset : 0;
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const read = async (fromOffset: number, append: boolean) => {
    if (shown === null || resolving) return;
    const mine = ++seq.current;
    setLoading(true); setError(null);
    const r = await nexusClient.jobLogs(jobId, { attempt: shown, fromOffset, maxBytes: LOG_PAGE_BYTES });
    if (mine !== seq.current) return;
    setLoading(false);
    if (!r.ok) { setError(execFailText(r)); return; }
    setPages((p) => (append ? [...p, r.data] : [r.data]));
  };
  useEffect(() => { setPages([]); void read(start, false); /* a new attempt or range starts over */ }, [shown, start, resolving]);

  const last = pages[pages.length - 1] ?? null;
  return (
    <div className="nx-xl">
      <header className="nx-xs__head">
        <p className="nx-xs__kind">Run log</p>
        <h2 id="nx-xl-title" className="nx-xs__title">{job.data ? jobTitle(job.data) : 'Log'}</h2>
      </header>
      {attempts.length > 1 && (
        <div className="nx-xl__attempts" role="group" aria-label="Attempt">
          {attempts.map((n) => (
            <button key={n} type="button" className="nx-btn nx-btn--quiet" aria-pressed={n === shown} onClick={() => setAttempt(n)}><span>Attempt {n}</span></button>
          ))}
        </div>
      )}
      {range && <p className="nx-muted">{range.label}{target !== null ? `, attempt ${target}.` : attempts.length > 1 ? '. The report does not say which attempt; pick the one it was made from.' : '.'} Hash {range.sha256}.</p>}
      {start > 0 && <p className="nx-muted">Starts at byte {start}.</p>}
      {shown === null && job.loaded && <p className="nx-muted">This job has no attempt yet, so it has no log.</p>}
      {pages.length > 0 && (
        <pre className="nx-xl__text" tabIndex={0} aria-label="Log text">{pages.map((p) => p.text).join('')}</pre>
      )}
      {last?.truncatedMiddle && <p className="nx-muted">Part of the middle of this log was not kept (it ran past its size limit).</p>}
      {last && !last.eof && <Button disabled={loading} onClick={() => { void read(last.nextOffset, true); }}>{loading ? 'Reading…' : 'Load more'}</Button>}
      {last?.eof && <p className="nx-muted">End of the log (byte {last.nextOffset}).</p>}
      {loading && pages.length === 0 && <p className="nx-muted" role="status">Reading the log…</p>}
      {error && <p className="nx-passport__note" role="alert">{error}</p>}
      <div className="nx-xs__actions"><Button onClick={onClose}>Close</Button></div>
    </div>
  );
}
