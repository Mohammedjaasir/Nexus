import { useEffect, useState } from 'react';

interface MemoryStatus {
  available: boolean;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  palacePath: string | null;
  model: 'minilm' | 'embeddinggemma';
  bin: string | null;
}

type ModelId = 'minilm' | 'embeddinggemma';

// Plain-language framing of each model — lead with the benefit the user actually
// chooses between, not the model's codename.
const MODELS: { id: ModelId; title: string; detail: string }[] = [
  { id: 'minilm',         title: 'Fast',         detail: 'English only · ~90 MB' },
  { id: 'embeddinggemma', title: 'Multilingual', detail: 'all languages · ~300 MB' },
];

/**
 * Lets the human search the shared memory agents build up across sessions, turn
 * it on/off, and pick how it searches. Agents read/write it directly; this is
 * the human-facing window into the same memory.
 */
/** `defaultOpen` is for hosts that provide their own toggle: it starts expanded and hides the inner Close. */
export function MemoryPanel({ defaultOpen }: { defaultOpen?: boolean } = {}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const refreshStatus = async () => {
    try { setStatus(await window.cth.memoryStatus()); } catch { /* ignore */ }
  };
  useEffect(() => { refreshStatus(); }, []);

  const setModel = async (model: ModelId) => {
    await window.cth.updateConfig({ embeddingModel: model });
    await refreshStatus();
  };
  const toggleEnabled = async () => {
    await window.cth.updateConfig({ semanticMemory: !(status?.enabled ?? true) });
    await refreshStatus();
  };

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setResult('');
    try {
      const res = await window.cth.searchMemory(query.trim());
      setResult(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally {
      setBusy(false);
    }
  };

  const active = status?.active;
  const pill = active ? `Memory · ${status?.model}` : 'Memory';

  // One clear state line: is memory working, off, or not set up?
  const state: { tone: 'ok' | 'warn' | 'bad' | 'off'; label: string } = !status?.available
    ? { tone: 'bad', label: 'Not set up' }
    : !status.enabled
      ? { tone: 'off', label: 'Off' }
      : status.initialized
        ? { tone: 'ok', label: 'On · ready' }
        : { tone: 'warn', label: 'On · getting ready…' };

  const canSearch = !!status?.available && !!status?.enabled;

  if (!open) {
    return (
      <button
        type="button"
        className="nx-btn nx-btn--sm nxh-mem__pill"
        onClick={() => { setOpen(true); refreshStatus(); }}
        title="Search the shared memory your agents build up"
      >
        {pill}
      </button>
    );
  }

  return (
    <div className="nxh-mem">
      {/* What this is — one plain line. */}
      <p className="nxh-note">
        What your agents remember across sessions, shared between them. Search it by meaning, not just exact words.
      </p>

      {/* Status + on/off — the two things the user controls at a glance. */}
      <div className="nxh-row" style={{ justifyContent: 'space-between' }}>
        <span className="nxh-row" role="status" style={{ gap: 6 }}>
          <span className="nxh-dot" data-tone={state.tone === 'off' ? undefined : state.tone} aria-hidden="true" />
          {state.label}
        </span>
        {status?.available && (
          <button
            type="button"
            className={`nx-btn nx-btn--sm${status.enabled ? '' : ' nx-btn--primary'}`}
            onClick={toggleEnabled}
          >
            {status.enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>

      {/* Not installed: Setup owns the platform-correct commands (uv, the live
          detected state, the delegate-to-the-lead path), so this links there. */}
      {!status?.available && (
        <div className="nxh-callout" data-tone="note">
          Meaning-based search isn't installed yet.
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              className="nx-btn nx-btn--sm nx-btn--primary"
              onClick={() => {
                // Prerequisites live in Settings.
                window.dispatchEvent(new CustomEvent('cth:open-settings', {
                  detail: { section: 'Prerequisites' }
                }));
                if (!defaultOpen) setOpen(false);
              }}
            >
              Set it up in Prerequisites
            </button>
          </div>
          <p className="nxh-hint">Agents still keep plain notes without it.</p>
        </div>
      )}

      {/* Model: a benefit-framed choice, not a codename dump. */}
      {status?.available && (
        <div className="nxh-field" style={{ marginTop: 0 }} role="group" aria-labelledby="nxh-mem-model">
          <span className="nxh-label" id="nxh-mem-model">Search language</span>
          <div className="nxh-seg">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                className="nxh-seg__opt"
                aria-pressed={status.model === m.id}
                onClick={() => setModel(m.id)}
              >
                {m.title}
                <span className="nxh-seg__detail">{m.detail}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Search the memory. */}
      {canSearch && (
        <div className="nxh-list">
          <div className="nxh-row" style={{ flexWrap: 'nowrap' }}>
            <input
              className="nxh-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
              placeholder="Search by meaning…"
              aria-label="Search memory by meaning"
            />
            <button type="button" className="nx-btn nx-btn--sm nx-btn--primary" onClick={run} disabled={busy}>
              {busy ? 'Searching…' : 'Search'}
            </button>
          </div>
          {result && <pre className="nxh-pre" role="status">{result}</pre>}
        </div>
      )}

      {!defaultOpen && (
        <div className="nxh-row" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--nx-line)', paddingTop: 8 }}>
          <button type="button" className="nx-btn nx-btn--sm nx-btn--quiet" onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
}
