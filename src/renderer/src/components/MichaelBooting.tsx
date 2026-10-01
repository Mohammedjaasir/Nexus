import { PixelPanel } from '@/components/PixelPanel';

/**
 * Loader shown while the lead (god) agent starts on launch. Replaces the
 * "add agent" prompt so a returning user doesn't see the empty-state
 * call-to-action before the lead agent has booted.
 */
export function MichaelBooting() {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none'
    }}>
      <div style={{ pointerEvents: 'auto', width: 360 }}>
        <PixelPanel variant="dialog" title="Starting" noPadding>
          <div style={{
            padding: 20,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14
          }}>
            {/* Staggered progress dots */}
            <div style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 8, height: 8, borderRadius: 4,
                    background: 'var(--cth-ink-500)',
                    animation: 'cth-pulse 1s ease-in-out infinite',
                    animationDelay: `${i * 0.2}s`
                  }}
                />
              ))}
            </div>
            <p style={{
              margin: 0, fontSize: 13, lineHeight: '20px', textAlign: 'center',
              color: 'var(--cth-ink-700)'
            }}>
              Starting the lead agent…
            </p>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
