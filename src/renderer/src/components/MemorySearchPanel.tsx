import { useEffect, useId, useState } from 'react';
import { useStore } from '@/store/store';
import { Button } from '@/nexus/ui/Button';
import { useCanonicalAgents, useRegistryIds } from '@/nexus/agents/agentIdentity';
import { displayAgents, visibleAgents } from '@shared/agentDisplay';

/** Memory search, hosted in the lead agent's workbench: exact text search over
 *  agent files, tasks and the board; semantic search (MemPalace); and one
 *  agent's memory file. Moved from the retired lead panel; styled with the
 *  workbench section classes (nexus/styles/workbench.css). The selected agent
 *  is controllable so the graph can jump to a memory file. */
export function MemorySearchPanel({ godId, who: controlledWho, onWho }: { godId: string; who?: string; onWho?: (id: string) => void }) {
  const allAgents = useStore((s) => s.agents);
  const hint = useRegistryIds();
  const agents = visibleAgents(allAgents, hint);
  const canon = useCanonicalAgents();
  const shownNames = displayAgents(canon, hint);
  // Selection is controllable from the graph section; falls back to local state.
  const [internalWho, setInternalWho] = useState<string>(godId);
  const who = controlledWho ?? internalWho;
  const setWho = onWho ?? setInternalWho;
  const [mem, setMem] = useState<{ text: string; error?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [searchOut, setSearchOut] = useState('');
  const [busy, setBusy] = useState(false);
  // Full-text search across agent files (board, tasks, memory).
  const [textQuery, setTextQuery] = useState('');
  const [textResults, setTextResults] = useState<Array<{ source: string; excerpt: string }>>([]);
  const [textSearched, setTextSearched] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [textBusy, setTextBusy] = useState(false);
  const uid = useId();

  useEffect(() => {
    let alive = true;
    setMem(null);
    window.cth.hiveMemory(who)
      .then((text) => { if (alive) setMem({ text }); })
      .catch((e: unknown) => { if (alive) setMem({ text: '', error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [who]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await window.cth.searchMemory(query.trim());
      setSearchOut(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } catch (e) {
      setSearchOut(`Couldn't search: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(false); }
  };

  const textSearch = async () => {
    if (!textQuery.trim()) return;
    setTextBusy(true);
    setTextError(null);
    try {
      const res = await window.cth.textSearch(textQuery.trim());
      setTextResults(res.ok ? res.results.slice(0, 10) : []);
      if (!res.ok) setTextError('The search could not run.');
    } catch (e) {
      setTextResults([]);
      setTextError(e instanceof Error ? e.message : String(e));
    } finally { setTextBusy(false); setTextSearched(true); }
  };

  return (
    <div className="nxs">
      <div className="nxs__inner nxs__inner--narrow">
        <header className="nxs__head">
          <h3 className="nxs__title">Memory</h3>
          <p className="nxs__lede">Search what the agents have written down, or read one agent&apos;s memory file.</p>
        </header>

        <section className="nxs__group" aria-labelledby={`${uid}-text`}>
          <h4 className="nxs__subtitle" id={`${uid}-text`}>Text search (board, tasks, memory)</h4>
          <form className="nxs-actions" onSubmit={(e) => { e.preventDefault(); void textSearch(); }}>
            <input
              className="nxs-input nxm-query"
              value={textQuery}
              onChange={(e) => setTextQuery(e.target.value)}
              placeholder="Find exact text in agent files, tasks and the board…"
              aria-label="Text search"
            />
            <Button type="submit" disabled={textBusy || !textQuery.trim()}>{textBusy ? 'Searching…' : 'Search'}</Button>
          </form>
          {textError && <p className="nxs__error" role="alert">Could not search: {textError}</p>}
          {textResults.length > 0 && (
            <ul className="nxs__list" aria-label="Text search results">
              {textResults.map((r, i) => (
                <li key={i} className="nxs-field">
                  <span className="nxs-id">{r.source}</span>
                  <pre className="nxa-board nxm-pre">{r.excerpt}</pre>
                </li>
              ))}
            </ul>
          )}
          {textSearched && !textError && textResults.length === 0 && <p className="nxs__note">Nothing matched.</p>}
        </section>

        <section className="nxs__group" aria-labelledby={`${uid}-sem`}>
          <h4 className="nxs__subtitle" id={`${uid}-sem`}>Semantic search (MemPalace)</h4>
          <form className="nxs-actions" onSubmit={(e) => { e.preventDefault(); void search(); }}>
            <input
              className="nxs-input nxm-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What do the agents know about…"
              aria-label="Semantic search"
            />
            <Button type="submit" disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</Button>
          </form>
          {searchOut && <pre className="nxa-board nxm-pre" role="status">{searchOut}</pre>}
        </section>

        <section className="nxs__group" aria-labelledby={`${uid}-file`}>
          <h4 className="nxs__subtitle" id={`${uid}-file`}>Memory file</h4>
          <div className="nxs-actions">
            <label className="nxs-label" htmlFor={`${uid}-who`}>Agent</label>
            <select id={`${uid}-who`} className="nxs-select" value={who} onChange={(e) => setWho(e.target.value)}>
              {agents.map((a) => (<option key={a.id} value={a.id}>{shownNames.get(a.id)?.label ?? 'Agent'}</option>))}
            </select>
          </div>
          {mem === null ? (
            <p className="nxs__note">Reading…</p>
          ) : mem.error ? (
            <p className="nxs__error" role="alert">Could not read memory: {mem.error}</p>
          ) : (
            <pre className="nxa-board nxm-pre" tabIndex={0} aria-label="Memory file">{mem.text || 'No memory recorded yet.'}</pre>
          )}
        </section>
      </div>
    </div>
  );
}
