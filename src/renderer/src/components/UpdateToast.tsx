/**
 * Auto-update toast (v0.3.4) — the visual half of the background updater.
 *
 * Main's updater (src/main/updater.ts) downloads a new release in the
 * background and pushes ONE of two states over `update:status`:
 *   - 'downloaded'        → the update is staged; offer "restart to update".
 *   - 'available-manual'  → this install can't self-update (win-portable,
 *                           updater error); offer a link to the release page.
 *
 * Mirrors CompletionToast: self-contained + self-subscribing, mounted once in
 * App.tsx, renders nothing when idle. Installation is ALWAYS user-initiated —
 * "later" just hides the toast until the next app start (or the 6h re-check).
 *
 * ─── v0.4.4: "What's new" ───────────────────────────────────────────────────
 * Both states already carried `notes` (the GitHub release body) and the toast
 * dropped it on the floor, so the only notification this app ever raises said
 * nothing but a version number. It now renders a digest of that body —
 * summarizeReleaseNotes() in src/shared/releaseNotes.ts does the parsing, and
 * lives there rather than here so it can be unit-tested without a renderer.
 *
 * Three rules this block obeys:
 *   1. No notes, no block. A release body that is missing, empty, or pure
 *      structure yields an empty digest and the toast renders EXACTLY as it did
 *      before — no orphan heading, no shifted buttons. Most bodies are like
 *      that, so this is the common path, not the edge case.
 *   2. Bounded height. The digest is capped in releaseNotes.ts AND clamped with
 *      a scroll here, because a toast that grows with the release notes is a
 *      dialog that covers the app.
 *   3. The star ask is shown AT MOST ONCE EVER, not once per release. A repeated
 *      ask is the kind of nagging that gets a notification muted, which would
 *      cost the updater its only channel. See STAR_ASK_KEY below.
 *
 * No new IPC and no new network call: "read more" reuses `updateOpenRelease`
 * (the same bridge the manual state's button has always used) and the star link
 * goes through the existing `openExternal` opener.
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { summarizeReleaseNotes } from '@shared/releaseNotes';
import { extractDropHtml } from '@shared/releaseDrop';
import { ReleaseDrop } from '@/components/ReleaseDrop';
import type { UpdateStatus } from '@shared/updateState';

/** The toast is the LOUD half — it only interrupts for the two states a user has
 *  to act on. Everything else (checking, available, download progress, errors)
 *  lives quietly in the toolbar badge next to the logo. */
type ToastStatus = Extract<UpdateStatus, { state: 'downloaded' | 'available-manual' }>;

function toastable(s: UpdateStatus): ToastStatus | null {
  return s.state === 'downloaded' || s.state === 'available-manual' ? s : null;
}

export function UpdateToast() {
  const [status, setStatus] = useState<ToastStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => window.cth.onUpdateStatus?.((next) => {
    const t = toastable(next);
    // A non-toastable state (a re-check, say) must not erase a toast the user
    // hasn't answered yet — only a new actionable state replaces it.
    if (t) setStatus(t);
  }), []);

  // A `cth:show-release-notes` event asks to re-open the release notes. This
  // surface owns the last status and the drop renderer, so it answers rather
  // than duplicating either. `updateCurrent()` is used instead of the remembered state because
  // "later" clears the local copy while main still holds it — dismissing a
  // release must not make it unreadable afterwards. With genuinely nothing to
  // show (a dev build, or an install already on the newest release) the honest
  // answer is the releases page, not an empty modal.
  useEffect(() => {
    const onShow = async () => {
      try {
        const cur = await window.cth.updateCurrent();
        const t = toastable(cur);
        if (t) { setStatus(t); return; }
      } catch { /* fall through to the page */ }
      void window.cth.updateOpenRelease();
    };
    window.addEventListener('cth:show-release-notes', onShow);
    return () => window.removeEventListener('cth:show-release-notes', onShow);
  }, []);

  const notes = useMemo(() => summarizeReleaseNotes(status?.notes), [status?.notes]);
  /** An authored <!-- drop --> block in the release body upgrades this whole
   *  moment from a corner toast to a centered release page. Absent (every
   *  release published so far), everything below behaves exactly as before —
   *  the digest path stays the default, not a fallback nobody exercises. */
  const dropHtml = useMemo(() => extractDropHtml(status?.notes), [status?.notes]);
  const version = status?.version ?? null;

  if (!status) return null;

  const restart = async () => {
    setBusy(true);
    try {
      const res = await window.cth.updateRestartAndInstall();
      if (!res.ok) setBusy(false); // stayed alive — let the user retry
    } catch { setBusy(false); }
  };

  /** Same call the manual state's button makes: main resolves `undefined` to
   *  the releases page and refuses any URL outside this repo. */
  const openRelease = () => {
    void window.cth.updateOpenRelease(status.state === 'available-manual' ? status.url : undefined);
  };

  // An authored release: hand the whole moment to the centered drop instead of
  // the corner toast. Every action it can take is passed in from here, so the
  // sandboxed frame never needs (and never gets) a route back into the app.
  if (dropHtml && version) {
    return (
      <ReleaseDrop
        version={version}
        html={dropHtml}
        canRestart={status.state === 'downloaded'}
        busy={busy}
        showStar={false}
        onRestart={() => void restart()}
        onOpenRelease={openRelease}
        onStar={() => {}}
        onDismiss={() => setStatus(null)}
      />
    );
  }

  const buttonStyle: React.CSSProperties = {
    padding: '3px 10px 1px',
    background: 'var(--cth-mint-light, #d0f0e0)',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
    fontFamily: 'var(--cth-font-ui)', fontSize: 12,
    color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
  };

  const linkStyle: React.CSSProperties = {
    fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)',
    textDecoration: 'underline', cursor: 'pointer'
  };

  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 400,
      maxWidth: 340,
      background: 'var(--cth-cream-50)',
      border: '1px solid var(--nx-line)', borderRadius: 'var(--nx-r-obj)', boxShadow: 'var(--nx-shadow-float)',
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 8,
      fontFamily: 'var(--cth-font-ui)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="sparkle" />
        <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontWeight: 600 }}>
          {status.state === 'downloaded'
            ? `Update v${status.version} downloaded`
            : `v${status.version} is available`}
        </span>
      </div>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
        {status.state === 'downloaded'
          ? 'Restart Nexus whenever you like to apply it — nothing restarts on its own.'
          : 'This install can’t update itself — grab the new build from the releases page.'}
      </span>

      {notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
            color: 'var(--cth-ink-500)', textTransform: 'uppercase'
          }}>
            What’s new
          </div>
          {/* The digest is already capped at ~280 chars; the clamp is the second
              belt, for the day a release body defeats the parser. */}
          <ul style={{
            listStyle: 'none', margin: 0, padding: '0 0 0 2px',
            maxHeight: 96, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 4
          }}>
            {notes.map((line, i) => (
              <li key={i} style={{
                display: 'flex', gap: 6,
                fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)'
              }}>
                <span aria-hidden style={{ color: 'var(--cth-ink-300)' }}>•</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a
              href={status.state === 'available-manual' ? status.url : undefined}
              onClick={(e) => { e.preventDefault(); openRelease(); }}
              style={linkStyle}
            >Read more</a>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={() => setStatus(null)}
          style={{ ...buttonStyle, background: 'var(--cth-cream-100)' }}
        >
          later
        </button>
        {status.state === 'downloaded' ? (
          <button onClick={restart} disabled={busy} style={buttonStyle}>
            {busy ? 'restarting…' : 'restart to update'}
          </button>
        ) : (
          <button
            onClick={openRelease}
            style={buttonStyle}
          >
            open releases
          </button>
        )}
      </div>
    </div>
  );
}
