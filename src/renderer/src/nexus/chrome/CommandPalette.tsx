import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { Icon } from '../icons';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';
import { buildPaletteIndex, searchPalette, type PaletteEntry } from './paletteIndex';

export function CommandPalette() {
  const open = useNexusUi((s) => s.paletteOpen);
  const setOpen = useNexusUi((s) => s.setPaletteOpen);
  const projects = useStore((s) => s.projects);
  const actions = useShellActions();
  const openMemory = useNexusUi((s) => s.openSemanticMemory);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const index = useMemo(() => buildPaletteIndex(projects), [projects]);
  const results = useMemo(() => searchPalette(index, q), [index, q]);

  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 0); } }, [open]);
  useEffect(() => { setSel(0); }, [q]);
  if (!open) return null;

  const run = (e: PaletteEntry) => {
    setOpen(false);
    if (e.route) navigate(e.route);
    else if (e.action === 'newProject') actions.openNewProject();
    else if (e.action === 'openIde') actions.openIde();
    else if (e.action === 'openSettings') actions.openSettings(e.settingsSection);
    else if (e.action === 'openSemanticMemory') { navigate({ name: 'agents' }); openMemory(); }
  };

  return (
    <div className="nx-palette-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="nx-palette nx-float" role="dialog" aria-modal="true" aria-label="Search">
        <div className="nx-palette__input">
          <Icon name="search" size={18} />
          <input
            ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects, workspaces, pages…"
            role="combobox" aria-expanded="true" aria-controls="nx-palette-list" aria-activedescendant={results[sel] ? `nx-pal-${results[sel].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter' && results[sel]) { e.preventDefault(); run(results[sel]); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="nx-palette-list" className="nx-palette__list" role="listbox">
          {results.length === 0 && <li className="nx-palette__empty" role="status">Nothing matches '{q.trim()}'</li>}
          {results.map((r, i) => (
            <li key={r.id} id={`nx-pal-${r.id}`} role="option" aria-selected={i === sel}
              className={`nx-palette__item${i === sel ? ' is-sel' : ''}`} onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); run(r); }}>
              <span className="nx-palette__group">{r.group}</span>
              <span className="nx-palette__label">{r.label}</span>
              {r.hint && <span className="nx-palette__hint">{r.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
