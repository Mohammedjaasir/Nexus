import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { CLONE_NODE_BLURB, type OrgTriggerConfig, type TriggerMode } from '@shared/triggers';
import { getOrgTrigger, setOrgTrigger as persistOrgTrigger } from './api';
import { Callout, Field, Hint, ModePicker, SecretField, Toggle } from './ui';

/**
 * ORGANISATION — peer messaging between teammates' clone nodes.
 *
 * Configuration only. There is no transport service yet, so a key saved here
 * starts nothing; it is the setting the service will read once it exists. The
 * copy says exactly that rather than implying a connection.
 *
 * Renders off the store mirror that Settings → Connections also renders off, and
 * follows the same mirror-then-persist rule: typing the key updates the mirror
 * (so Settings stays live) and commits on blur; the toggle and the trust mode
 * persist on the spot.
 */
export function OrgSection({ onSummary }: { onSummary?: (s: string) => void }) {
  const cfg = useStore((s) => s.orgTrigger);
  const mirror = useStore((s) => s.setOrgTrigger);
  const [revealed, setRevealed] = useState(false);
  /** Why the last save could not store the key (main saved the rest). */
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Only when the mirror looks unseeded — adopting unconditionally could
    // clobber a key being typed in Settings this second.
    if (useStore.getState().orgTrigger.apiKey) return;
    void getOrgTrigger().then((c) => {
      if (c && !useStore.getState().orgTrigger.apiKey) mirror(c);
    });
  }, [mirror]);

  // Main never sends the stored key (O.9 #8): `hasApiKey` says one is saved.
  const hasKey = cfg.apiKey.trim().length > 0 || cfg.hasApiKey === true;

  useEffect(() => {
    onSummary?.(!hasKey ? 'no key' : cfg.enabled ? 'on' : 'off');
  }, [cfg, hasKey, onSummary]);

  const apply = (next: OrgTriggerConfig, persist = true) => {
    mirror(next);
    if (!persist) return;
    void persistOrgTrigger(next).then(({ trigger: stored, error }) => {
      setSaveError(error ?? null);
      if (stored && typeof stored.hasApiKey === 'boolean') mirror({ ...next, hasApiKey: stored.hasApiKey });
    });
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)' }}>
          Accept messages from your organisation
        </span>
        <Toggle on={cfg.enabled} onClick={() => apply({ ...cfg, enabled: !cfg.enabled })} />
      </div>

      <Field label="ORGANISATION KEY">
        <SecretField
          value={cfg.apiKey}
          revealed={revealed}
          onReveal={() => setRevealed((r) => !r)}
          placeholder={cfg.hasApiKey ? 'Saved. Enter a new value to replace it.' : 'paste your key'}
          onChange={(apiKey) => apply({ ...cfg, apiKey }, false)}
          onBlur={() => apply(cfg)}
        />
        <Hint>{CLONE_NODE_BLURB}</Hint>
        {saveError && <Callout>{saveError}</Callout>}
      </Field>

      <Field label="TRUST">
        <ModePicker value={cfg.mode} onChange={(mode: TriggerMode) => apply({ ...cfg, mode })} />
      </Field>

      <Callout tone="note">
        Settings only, for now. The org messaging service does not exist yet, so a key here starts no
        connection and nothing is sent or received. It is stored ready for when it does.
      </Callout>

      {cfg.enabled && !hasKey && (
        <Callout>This is switched on with no key set, so no teammate can reach you yet.</Callout>
      )}
    </>
  );
}
