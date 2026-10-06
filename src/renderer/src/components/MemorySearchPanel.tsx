import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { useStore } from '@/store/store';
import { useCanonicalAgents, useRegistryIds } from '@/nexus/agents/agentIdentity';
import { displayAgents, visibleAgents } from '@shared/agentDisplay';

/** Memory search, hosted in the lead agent's workbench: exact text search over
 *  agent files, tasks and the board; semantic search (MemPalace); and one
 *  agent's memory file. Moved from the retired lead panel with neutral copy.
 *  The selected agent is controllable so the graph can jump to a memory file. */
export function MemorySearchPanel({ godId, who: controlledWho, onWho }: { godId: string; who?: string; onWho?: (id: string) => void }) {
  const allAgents = useStore((s) => s.agents);
  const hint = useRegistryIds();
  const agents = visibleAgents(allAgents, hint);
  const canon = useCanonicalAgents();
  const shownNames = displayAgents(canon, hint);
  // Selection is controllable from the graph tab; falls back to local state.
  const [internalWho, setInternalWho] = useState<string>(godId);
  const who = controlledWho ?? internalWho;
  const setWho = onWho ?? setInternalWho;
  const [mem, setMem] = useState('');
  const [query, setQuery] = useState('');
  const [searchOut, setSearchOut] = useState('');
  const [busy, setBusy] = useState(false);
  // Full-text search across agent files (board, tasks, memory).
  const [textQuery, setTextQuery] = useState('');
  const [textResults, setTextResults] = useState<Array<{ source: string; excerpt: string }>>([]);
  const [textSearched, setTextSearched] = useState(false);
  const [textBusy, setTextBusy] = useState(false);

  useEffect(() => {
    window.cth.hiveMemory(who).then(setMem).catch(() => setMem(''));
  }, [who]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await window.cth.searchMemory(query.trim());
      setSearchOut(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally { setBusy(false); }
  };

  const textSearch = async () => {
    if (!textQuery.trim()) return;
    setTextBusy(true);
    try {
      const res = await window.cth.textSearch(textQuery.trim());
      setTextResults(res.ok ? res.results.slice(0, 10) : []);
    } catch { setTextResults([]); }
    finally { setTextBusy(false); setTextSearched(true); }
  };

  return (
    <Scroll>
      <Section title="TEXT SEARCH (board, tasks, memory)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={textQuery}
            onChange={(e) => setTextQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') textSearch(); }}
            placeholder="Find exact text in agent files, tasks and the board…"
            aria-label="Text search"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={textSearch} disabled={textBusy || !textQuery.trim()}>
            {textBusy ? '…' : 'search'}
          </PixelButton>
        </div>
        {textResults.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {textResults.map((r, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{r.source}</div>
                <Pre>{r.excerpt}</Pre>
              </div>
            ))}
          </div>
        )}
        {textSearched && textResults.length === 0 && <Muted>Nothing matched.</Muted>}
      </Section>

      <Section title="SEMANTIC SEARCH (MemPalace)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            placeholder="What do the agents know about…"
            aria-label="Semantic search"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={search} disabled={busy || !query.trim()}>
            {busy ? '…' : 'search'}
          </PixelButton>
        </div>
        {searchOut && <Pre>{searchOut}</Pre>}
      </Section>

      <Section title="MEMORY FILE">
        <Select value={who} onChange={setWho} ariaLabel="Agent whose memory file is shown">
          {agents.map((a) => (<option key={a.id} value={a.id}>{shownNames.get(a.id)?.label ?? 'Agent'}</option>))}
        </Select>
        <Pre>{mem || 'No memory recorded yet.'}</Pre>
      </Section>
    </Scroll>
  );
}

function Scroll({ children }: { children: React.ReactNode }) {
  // minWidth:0 + overflowX:hidden keep wide children (native selects, long paths,
  // budget rows) from forcing a horizontal scrollbar in the narrow sidebar — they
  // wrap/shrink instead. Vertical scroll stays.
  return <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 10, background: 'var(--cth-paper-200)' }}>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre style={{
      margin: '6px 0 0', padding: 8, maxHeight: 200, overflow: 'auto',
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
      color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
    }}>{children}</pre>
  );
}

const textareaStyle: React.CSSProperties = {
  flex: 1, width: '100%', resize: 'none', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '17px',
  color: 'var(--cth-ink-900)', boxSizing: 'border-box'
};

function Select({ value, onChange, disabled, ariaLabel, children }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; ariaLabel?: string; children: React.ReactNode;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '3px 6px', background: 'var(--cth-paper-100)',
        border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer',
        // Never let a long option name push the sidebar wider than it is.
        minWidth: 0, maxWidth: '100%'
      }}
    >{children}</select>
  );
}
