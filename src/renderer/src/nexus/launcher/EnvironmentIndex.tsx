import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { IndexEntry } from './indexModel';
import { matchEntries, moveActive, resolveEnter } from './indexModel';
import { ProvenanceMark, provenanceStyle } from '../ui/ProvenanceMark';
import { getWorkspace } from '../workspaces/registry';
import { highlightSegments } from './highlight';
import { typewriterText } from './typewriter';

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

export function EnvironmentIndex({ entries, initialId, onActive, onOpen }: {
  entries: IndexEntry[];
  initialId: string | null;
  onActive: (id: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, entries.findIndex((e) => e.id === initialId)));
  const [glide, setGlide] = useState<{ y: number; h: number } | null>(null);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const rows = useRef<Map<string, HTMLLIElement>>(new Map());
  const reduced = useReducedMotion();
  const shown = useMemo(() => matchEntries(entries, query), [entries, query]);
  const placeholder = useTypedPlaceholder(!reduced && !focused && query === '');

  const setActiveIndex = (i: number) => { setActive(i); onActive(shown[i]?.id ?? null); };
  const onQuery = (q: string) => { setQuery(q); const next = matchEntries(entries, q); setActive(next.length ? 0 : -1); onActive(next[0]?.id ?? null); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(moveActive(active, 1, shown.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(moveActive(active, -1, shown.length)); }
    else if (e.key === 'Enter') { const id = resolveEnter(shown, active); if (id) onOpen(id); }
    else if (e.key === 'Escape') { onQuery(''); }
  };
  const optionId = (id: string) => `${listId}-${id}`;

  // The highlight is one element that glides to the active row, rather than
  // a background that jumps between rows.
  const activeKey = shown[active]?.id ?? null;
  useLayoutEffect(() => {
    const el = activeKey ? rows.current.get(activeKey) : null;
    setGlide(el ? { y: el.offsetTop, h: el.offsetHeight } : null);
  }, [activeKey, shown]);

  // Cursor spotlight: written straight to CSS variables, no re-render.
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = wrap.current; if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  const activeWs = activeKey ? getWorkspace(activeKey) : null;

  return (
    <div className="nx-index">
      <label className="nx-typeline">
        <span className="nx-visually-hidden">Find an environment</span>
        <input ref={input} className="nx-typeline__input" role="combobox" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={shown[active] ? optionId(shown[active].id) : undefined} aria-autocomplete="list"
          value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKey}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          placeholder={placeholder} />
        <span className="nx-typeline__count" aria-hidden="true">{shown.length}/{entries.length}</span>
      </label>
      <div ref={wrap} className="nx-index__stage" onMouseMove={onMove}>
        <span className="nx-index__spot" aria-hidden="true" />
        {glide && (
          <span className="nx-glide nx-prov" aria-hidden="true"
            style={{ transform: `translateY(${glide.y}px)`, height: glide.h, ...provenanceStyle(activeWs?.hueSlot ?? null) } as CSSProperties} />
        )}
        <ul id={listId} role="listbox" aria-label="Environments" className="nx-index__list">
          {shown.map((e, i) => {
            const ws = getWorkspace(e.id);
            const selected = i === active;
            return (
              <li key={e.id} id={optionId(e.id)} role="option" aria-selected={selected}
                ref={(el) => { if (el) rows.current.set(e.id, el); else rows.current.delete(e.id); }}
                className="nx-index__row nx-prov" style={{ ['--i' as string]: i, ...provenanceStyle(ws?.hueSlot ?? null) } as CSSProperties}
                onMouseEnter={() => setActiveIndex(i)} onClick={() => onOpen(e.id)}>
                <ProvenanceMark slot={ws?.hueSlot ?? null} size={10} />
                <span className="nx-index__name">
                  {highlightSegments(e.name, query).map((s, k) => (s.hit ? <mark key={k} className="nx-hit">{s.text}</mark> : <span key={k}>{s.text}</span>))}
                </span>
                <span className="nx-index__vocab">{e.vocabulary.join(', ').toLowerCase()}</span>
                <span className="nx-index__go" aria-hidden="true">↵</span>
              </li>
            );
          })}
        </ul>
      </div>
      {shown.length === 0 && <p className="nx-index__none" role="status">No environment matches "{query.trim()}". Press Escape to see all.</p>}
    </div>
  );
}
