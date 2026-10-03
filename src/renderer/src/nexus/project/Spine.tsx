import { useRef, type KeyboardEvent } from 'react';
import type { SpineGroup } from './spineModel';
import { nodeLabel, tabStopId } from './spineModel';
import { provenanceStyle } from '../ui/ProvenanceMark';

export function Spine({ groups, selectedId, onSelect }: { groups: SpineGroup[]; selectedId: string; onSelect: (id: string, el?: HTMLElement) => void }) {
  const flat = groups.flatMap((g) => g.nodes.map((n) => n.id));
  const active = tabStopId(flat, selectedId);
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const focusAt = (i: number) => { const id = flat[Math.max(0, Math.min(flat.length - 1, i))]; refs.current.get(id)?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
    else if (e.key === 'End') { e.preventDefault(); focusAt(flat.length - 1); }
  };
  let i = -1;
  return (
    <nav className="nx-spine" aria-label="Project spine">
      {groups.map((g) => (
        <div key={g.workspaceId} className={g.hueSlot === null ? 'nx-spine__group nx-prov nx-prov--none' : 'nx-spine__group nx-prov'} style={provenanceStyle(g.hueSlot)}>
          <p className="nx-spine__label">{g.label}</p>
          <ol className="nx-spine__nodes">
            {g.nodes.map((n) => {
              i += 1; const idx = i;
              const sel = n.id === selectedId;
              return (
                <li key={n.id} className="nx-spine__item">
                  {idx > 0 && <span className="nx-spine__link" aria-hidden="true" />}
                  <button type="button" ref={(el) => { if (el) refs.current.set(n.id, el); }}
                    className={`nx-node${n.kind === 'changes' ? ' nx-node--draft' : ''}`} aria-current={sel ? 'true' : undefined}
                    aria-label={nodeLabel(n)} tabIndex={n.id === active ? 0 : -1} onClick={(e) => onSelect(n.id, e.currentTarget)} onKeyDown={(e) => onKey(e, idx)}>
                    <span className="nx-node__k">{n.kind === 'changes' ? 'changes' : n.vcs === 'git' ? 'repository' : 'folder'}</span>
                    <span className="nx-node__n">{n.kind === 'changes' ? `${n.fileCount} ${n.fileCount === 1 ? 'file' : 'files'}` : n.kind === 'source' && n.branch ? n.branch : 'Project files'}</span>
                    {n.kind === 'source' && n.head && <span className="nx-node__v nx-id">{n.head.shortSha}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
      <p className="nx-spine__future">Artifacts this project produces will appear on this line.</p>
    </nav>
  );
}
