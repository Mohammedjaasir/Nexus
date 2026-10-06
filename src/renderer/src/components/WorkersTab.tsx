import { useEffect, useState, useCallback } from 'react';

/**
 * WORKERS — live god-triggered ephemeral Slack workers (the Phase-1 spawn loop):
 * fresh isolated worktree → does a job → replies in-thread → safe teardown. This
 * tab reads main's `liveWorkers` map (via workers:list) so a human can SEE what's
 * running and stop one by hand; it also surfaces worktrees PRESERVED at teardown
 * (held until their work integrates, then auto-GC'd) so nothing silently piles up.
 */

// Types flow from main's `workers:list` handler via the typed `window.cth` global
// (declared in preload/index.d.ts) — derived here so there's no cross-package import.
type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;
type WorkerSnapshot = WorkersData['live'][number];
type PreservedWorktreeSnapshot = WorkersData['preserved'][number];

const POLL_MS = 2000;

function relAge(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function StatusBadge({ w }: { w: WorkerSnapshot }) {
  const releasing = w.status === 'releasing';
  return <span className="nxh-chip" data-tone={releasing ? undefined : 'ok'}>{releasing ? 'stopping' : 'working'}</span>;
}

export function WorkersTab() {
  const [data, setData] = useState<WorkersData | null>(null);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});

  const refresh = useCallback(() => {
    window.cth.listWorkers().then(setData).catch(() => { /* main not ready */ });
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const stop = useCallback((workerId: string) => {
    setStopping((s) => ({ ...s, [workerId]: true }));
    window.cth.stopWorker(workerId)
      .catch(() => { /* surfaced by the row vanishing or not */ })
      .finally(() => { refresh(); });
  }, [refresh]);

  const live = data?.live ?? [];
  const preserved = data?.preserved ?? [];
  const max = data?.maxWorkers ?? 4;

  return (
    <div className="nxh">
      <section className="nxh-list" aria-labelledby="nxh-workers-live">
        <div className="nxh-head">
          <h3 className="nxh-title" id="nxh-workers-live">Live workers</h3>
          <span className="nxh-meta">{live.length} / {max}</span>
        </div>
        <p className="nxh-note">
          Isolated workers the lead agent spins up to handle Slack messages — they run to completion, reply in-thread, then tear down.
        </p>

        {live.length === 0 ? (
          <div className="nxh-card"><p className="nxh-muted" role="status">No workers running right now.</p></div>
        ) : (
          <div className="nxh-list">
            {live.map((w) => (
              <div key={w.workerId} className="nxh-card">
                <div className="nxh-row" style={{ flexWrap: 'nowrap' }}>
                  <StatusBadge w={w} />
                  <span className="nxh-name">{w.name}</span>
                  {w.hasSlack && <span className="nxh-chip" title="replies to a Slack thread">Slack</span>}
                  <button
                    type="button"
                    className="nx-btn nx-btn--sm"
                    onClick={() => stop(w.workerId)}
                    disabled={w.releasing || !!stopping[w.workerId]}
                  >
                    {w.releasing || stopping[w.workerId] ? 'Stopping…' : 'Stop'}
                  </button>
                </div>
                <div className="nxh-meta">
                  <span title="worker / PTY id">{w.workerId}</span>
                  <span title="base branch the worktree was cut from">base: {w.baseBranch}</span>
                  <span title="time since spawn">up {relAge(w.ageMs)}</span>
                  <span title="time since last terminal output">
                    {w.idleMs === null ? 'pty gone' : `idle ${relAge(w.idleMs)}`}
                  </span>
                  <span title="cumulative tokens (input+output+cache)">
                    tokens {fmtTokens(w.tokensUsed)}{w.tokenCap !== null ? ` / ${fmtTokens(w.tokenCap)}` : ' · uncapped'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {preserved.length > 0 && (
        <section className="nxh-list" aria-labelledby="nxh-workers-kept">
          <h3 className="nxh-title" id="nxh-workers-kept">Preserved worktrees ({preserved.length})</h3>
          <p className="nxh-note">
            Finished workers whose worktree held un-integrated work — kept (never auto-discarded) and auto-reclaimed once the work lands in its base branch.
          </p>
          <div className="nxh-list">
            {preserved.map((p) => (
              <div key={p.wtPath} className="nxh-card">
                <div className="nxh-name">{p.workerId}</div>
                <div className="nxh-meta">
                  <span style={{ wordBreak: 'break-all' }}>{p.wtPath}</span>
                  <span>base: {p.baseBranch}</span>
                  <span>kept {relAge(Math.max(0, Date.now() - p.preservedAt))} ago</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
