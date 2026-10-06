import { useEffect, useRef, useState } from 'react';

/** Operator control for one agent (#7C.1–7C.3) — pause (deny tools at the next
 *  boundary), graceful halt (clean stop), and mid-run steering (inject context
 *  without typing into the TUI). All ride Claude Code's hook-return protocol; no
 *  PTY keystrokes. A thin strip under the agent header. */
interface Snapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

export function AgentControlStrip({ agentId }: { agentId: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [steer, setSteer] = useState('');
  const [note, setNote] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    window.cth.controlSnapshot(agentId).then((s) => { if (alive && s) setSnap(s); }).catch(() => { /* none */ });
    return () => { alive = false; };
  }, [agentId]);

  const flash = (m: string) => {
    setNote(m);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(''), 1800);
  };

  const togglePause = async () => {
    const s = snap?.paused ? await window.cth.controlResume(agentId) : await window.cth.controlPause(agentId, true);
    if (s) setSnap(s);
    flash(snap?.paused ? 'resumed' : 'paused — tool calls will be denied');
  };
  const halt = async () => {
    const s = await window.cth.controlHalt(agentId);
    if (s) setSnap(s);
    flash('halt requested — stops cleanly at next hook');
  };
  const sendSteer = async () => {
    const t = steer.trim();
    if (!t) return;
    const s = await window.cth.controlSteer(agentId, t);
    if (s) setSnap(s);
    setSteer('');
    flash('steer queued — delivered on next turn');
  };

  return (
    <div className="nxh-list" style={{
      gap: 6, padding: '8px 12px', background: 'var(--nx-surface)',
      borderBottom: '1px solid var(--nx-line)', flexShrink: 0
    }}>
      <div className="nxh-row" style={{ gap: 6 }}>
        <span className="nxh-label" style={{ marginRight: 2 }}>Control</span>
        {/* Neither of these kills anything, and the two-word labels never said
            so — the difference is WHEN the agent stops and whether it keeps its
            session. Spelled out on hover rather than left to be discovered. */}
        <button
          type="button"
          className={`nx-btn nx-btn--sm${snap?.paused ? ' nx-btn--primary' : ''}`}
          onClick={togglePause}
          title={snap?.paused
            ? 'Resume — allow tool calls again. The agent keeps its session and picks up where it stopped.'
            : 'Pause — deny every tool call from the next one onward. The agent keeps thinking and talking but cannot read, write or run anything. Takes effect immediately; reversible.'}
        >
          {snap?.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="nx-btn nx-btn--sm nx-btn--danger"
          onClick={halt}
          title="Halt — ask the agent to stop CLEANLY at its next hook boundary (usually the end of the current step), instead of killing the process. Its session survives, so Restart & Continue can resume it. Use the ✕ to end the process outright."
        >
          Halt
        </button>
        {/* The auto-delivery switch lives in the lead agent's workbench header:
            ONE control for all agents instead of a per-agent toggle. */}
        {snap?.autoDeliveryPaused && (
          <span className="nxh-muted">delivery paused (all agents)</span>
        )}
        {snap?.halted && <span className="nxh-error" role="status">halting…</span>}
        {!!snap?.pendingSteers && <span className="nxh-muted">{snap.pendingSteers} steer queued</span>}
      </div>
      <div className="nxh-row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input
          className="nxh-input"
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') sendSteer(); }}
          placeholder="steer this agent (injected as context, no typing into its terminal)…"
          aria-label="Steer this agent"
        />
        <button type="button" className="nx-btn nx-btn--sm" onClick={sendSteer} disabled={!steer.trim()}>Steer</button>
      </div>
      {note && <span className="nxh-muted" role="status">{note}</span>}
    </div>
  );
}
