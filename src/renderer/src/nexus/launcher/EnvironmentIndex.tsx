import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { IndexEntry } from './indexModel';
import { matchEntries, moveActive, resolveEnter } from './indexModel';
import { ProvenanceMark } from '../ui/ProvenanceMark';
import { getWorkspace } from '../workspaces/registry';

export function EnvironmentIndex({ entries, initialId, onActive, onOpen }: {
  entries: IndexEntry[];
  initialId: string | null;
  onActive: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() => Math.max(0, entries.findIndex((e) => e.id === initialId)));
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => matchEntries(entries, query), [entries, query]);

  const setActiveIndex = (i: number) => { setActive(i); onActive(shown[i]?.id ?? null); };
  const onQuery = (q: string) => { setQuery(q); const next = matchEntries(entries, q); setActive(next.length ? 0 : -1); onActive(next[0]?.id ?? null); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(moveActive(active, 1, shown.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(moveActive(active, -1, shown.length)); }
    else if (e.key === 'Enter') { const id = resolveEnter(shown, active); if (id) onOpen(id); }
    else if (e.key === 'Escape') { onQuery(''); }
  };
  const optionId = (id: string) => `${listId}-${id}`;

  return (
    <div className="nx-index">
      <label className="nx-typeline">
        <span className="nx-visually-hidden">Find an environment</span>
        <input ref={input} className="nx-typeline__input" role="combobox" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={shown[active] ? optionId(shown[active].id) : undefined} aria-autocomplete="list"
          value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKey}
          placeholder='Type a kind of work, or a thing like "model" or "dashboard"' />
      </label>
      <ul id={listId} role="listbox" aria-label="Environments" className="nx-index__list">
        {shown.map((e, i) => {
          const ws = getWorkspace(e.id);
          return (
            <li key={e.id} id={optionId(e.id)} role="option" aria-selected={i === active}
              className="nx-index__row" onMouseEnter={() => setActiveIndex(i)} onClick={() => onOpen(e.id)}>
              <ProvenanceMark slot={ws?.hueSlot ?? null} size={10} />
              <span className="nx-index__name">{e.name}</span>
              <span className="nx-index__vocab">{e.vocabulary.join(', ').toLowerCase()}</span>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="nx-index__none" role="status">No environment matches "{query.trim()}". Press Escape to see all.</p>}
    </div>
  );
}
