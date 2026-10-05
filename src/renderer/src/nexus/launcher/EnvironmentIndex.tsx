import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { IndexEntry } from './indexModel';
import { matchEntries, resolveEnter } from './indexModel';
import { provenanceStyle } from '../ui/ProvenanceMark';
import { getWorkspace } from '../workspaces/registry';
import { highlightSegments } from './highlight';
import { typewriterText } from './typewriter';
import { gridMove } from './gridNav';
import { TileScene } from './TileScene';

const STATIC_PLACEHOLDER = 'Type a kind of work, or a thing like "model" or "dashboard"';

function useReducedMotion(): boolean {
  const q = '(prefers-reduced-motion: reduce)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, []);
  return m;
}

/** While the line is empty and idle it types example searches, so the page
 *  reads as alive and shows what can be found. Off under reduced motion. */
function useTypedPlaceholder(active: boolean): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => setTick((t) => t + 1), 95);
    return () => clearInterval(iv);
  }, [active]);
  return active ? `Type a kind of work, like "${typewriterText(tick)}"` : STATIC_PLACEHOLDER;
}

/** Tilt toward the pointer and move the sheen, written straight to CSS
 *  variables so hovering never re-renders the grid. */
function tilt(e: PointerEvent<HTMLDivElement>) {
  const el = e.currentTarget; const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  el.style.setProperty('--ry', `${((x - 0.5) * 9).toFixed(2)}deg`);
  el.style.setProperty('--rx', `${((0.5 - y) * 9).toFixed(2)}deg`);
  el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
  el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
}
function untilt(e: PointerEvent<HTMLDivElement>) {
  e.currentTarget.style.setProperty('--rx', '0deg');
  e.currentTarget.style.setProperty('--ry', '0deg');
}

export function EnvironmentIndex({ entries, initialId, onActive, onOpen }: {
  entries: IndexEntry[];
  initialId: string | null;
  onActive: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, entries.findIndex((e) => e.id === initialId)));
  const listId = useId();
  const grid = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const shown = useMemo(() => matchEntries(entries, query), [entries, query]);
  const placeholder = useTypedPlaceholder(!reduced && !focused && query === '');

  const setActiveIndex = (i: number) => { if (i === active) return; setActive(i); onActive(shown[i]?.id ?? null); };
  const onQuery = (q: string) => { setQuery(q); const next = matchEntries(entries, q); setActive(next.length ? 0 : -1); onActive(next[0]?.id ?? null); };
  const columns = () => (grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').filter(Boolean).length : 1);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { const id = resolveEnter(shown, active); if (id) onOpen(id); return; }
    if (e.key === 'Escape') { onQuery(''); return; }
    // Left/right belong to the text caret while there is text to move through.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && query) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    setActiveIndex(gridMove(active, e.key, columns(), shown.length));
  };
  const optionId = (id: string) => `${listId}-${id}`;

  return (
    <div className="nx-index">
      <label className="nx-typeline">
        <span className="nx-visually-hidden">Find an environment</span>
        <input className="nx-typeline__input" role="combobox" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={shown[active] ? optionId(shown[active].id) : undefined} aria-autocomplete="list"
          value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKey}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          placeholder={placeholder} />
        <span className="nx-typeline__count" aria-hidden="true">{shown.length}/{entries.length}</span>
      </label>
      <div ref={grid} id={listId} role="listbox" aria-label="Environments" className="nx-tiles">
        {shown.map((e, i) => {
          const ws = getWorkspace(e.id);
          const selected = i === active;
          return (
            <div key={e.id} id={optionId(e.id)} role="option" aria-selected={selected}
              className={`nx-tile${ws ? ' nx-prov' : ' nx-prov nx-prov--none'}`}
              style={{ ['--i' as string]: i, ...provenanceStyle(ws?.hueSlot ?? null) } as CSSProperties}
              onMouseEnter={() => setActiveIndex(i)} onClick={() => onOpen(e.id)}
              onPointerMove={reduced ? undefined : tilt} onPointerLeave={reduced ? undefined : untilt}>
              <span className="nx-tile__clouds" aria-hidden="true"><i /><i /></span>
              <span className="nx-tile__sheen" aria-hidden="true" />
              <div className="nx-tile__scene"><TileScene id={e.id} /></div>
              <div className="nx-tile__meta">
                <span className="nx-tile__name">
                  <span className="nx-tile__mark" aria-hidden="true" />
                  <span>{highlightSegments(e.name, query).map((s, k) => (s.hit ? <mark key={k} className="nx-hit">{s.text}</mark> : <span key={k}>{s.text}</span>))}</span>
                </span>
                <span className="nx-tile__vocab">{e.vocabulary.join(', ').toLowerCase()}</span>
              </div>
              <span className="nx-tile__go" aria-hidden="true">↵ open</span>
            </div>
          );
        })}
      </div>
      {shown.length === 0 && <p className="nx-index__none" role="status">No environment matches "{query.trim()}". Press Escape to see all.</p>}
    </div>
  );
}
