import { AUTO_MODE_BANNER } from '@shared/autoModeReview';
import { useAutoModeReview } from './useAutoModeReview';

/** The Agents page's one-time auto mode review (O.9 #10). Renders nothing once
 *  answered, or when auto mode is off. */
export function AutoModeBanner({ onAnswered }: { onAnswered?: (autoMode: boolean) => void }) {
  const { needs, busy, error, turnOff, keep } = useAutoModeReview();
  if (!needs) return null;
  return (
    <section className="nxa__banner" role="region" aria-labelledby="nxa-auto-banner-title">
      <div className="nxa__banner-text">
        <h2 id="nxa-auto-banner-title" className="nxa__banner-title">{AUTO_MODE_BANNER.title}</h2>
        <p className="nxa__banner-body">{AUTO_MODE_BANNER.body}</p>
        {error ? <p className="nxa__banner-error" role="alert">{error}</p> : null}
      </div>
      <div className="nxa__banner-actions">
        <button
          type="button"
          className="nx-btn nx-btn--primary nx-focusable"
          disabled={busy}
          onClick={() => { void turnOff().then((c) => { if (c) onAnswered?.(c.autoMode === true); }); }}
        >
          {AUTO_MODE_BANNER.turnOff}
        </button>
        <button
          type="button"
          className="nx-btn nx-focusable"
          disabled={busy}
          onClick={() => { void keep().then((c) => { if (c) onAnswered?.(c.autoMode === true); }); }}
        >
          {AUTO_MODE_BANNER.keep}
        </button>
      </div>
    </section>
  );
}
