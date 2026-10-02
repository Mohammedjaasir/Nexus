import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { WORKSPACES, LAUNCHER_SHORTCUTS } from '../workspaces/registry';
import { countsByWorkspace } from '../workspaces/mapping';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { nextHotspot, type Dir } from './hotspotNav';
import { ISLAND_ART_URL } from './islandArt';
import { WorkspaceHotspot, type HotspotModel } from './WorkspaceHotspot';
import { ArchipelagoScene } from './ArchipelagoScene';

const KEY_DIR: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, [q]);
  return m;
}

export function IslandStage() {
  const projects = useStore((s) => s.projects);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const grid = useMedia('(max-width: 899px)');
  const reducedMotion = useMedia('(prefers-reduced-motion: reduce)');
  const [active, setActive] = useState<string | null>(null);
  const [artLoaded, setArtLoaded] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const models: HotspotModel[] = useMemo(() => {
    const counts = countsByWorkspace(projects);
    const ws = WORKSPACES.map((w) => ({
      key: w.id, label: w.label, tagline: w.tagline, description: w.description, icon: w.icon, hue: w.hue,
      x: w.island.x, y: w.island.y, count: counts[w.id],
      onOpen: () => { setLast(w.id); navigate({ name: 'workspace', id: w.id }); }
    }));
    const shortcuts = LAUNCHER_SHORTCUTS.map((s) => ({
      key: s.id, label: s.label, tagline: '', description: 'All your projects, across every workspace.', icon: s.icon, hue: 'accent' as const,
      x: s.island.x, y: s.island.y, count: projects.length || null, onOpen: () => navigate({ name: 'projects' })
    }));
    return [...ws, ...shortcuts];
  }, [projects, setLast]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (grid) return;
    let next = -1;
    if (KEY_DIR[e.key]) next = nextHotspot(models, focusIndex, KEY_DIR[e.key]);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = models.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setFocusIndex(next);
    refs.current[next]?.focus();
  };

  return (
    <section className={`nx-stage${grid ? ' nx-stage--grid' : ''}`} aria-label="Workspaces">
      {!grid && (
        <div className="nx-stage__art" aria-hidden="true">
          <div className="nx-stage__sky"><span className="nx-cloud nx-cloud--a" /><span className="nx-cloud nx-cloud--b" /><span className="nx-cloud nx-cloud--c" /></div>
          {!artLoaded && <ArchipelagoScene active={active} motion={!reducedMotion} />}
          {ISLAND_ART_URL && !artFailed && (
            <img className={`nx-stage__img${artLoaded ? ' is-loaded' : ''}`} src={ISLAND_ART_URL} alt="" onLoad={() => setArtLoaded(true)} onError={() => setArtFailed(true)} />
          )}
        </div>
      )}
      <div className={grid ? 'nx-stage__grid' : 'nx-stage__layer'} role={grid ? undefined : 'group'} aria-roledescription={grid ? undefined : 'launcher map'}>
        {models.map((m, i) => (
          <WorkspaceHotspot key={m.key} ref={(el) => { refs.current[i] = el; }} model={m} index={i} focusIndex={focusIndex} mode={grid ? 'grid' : 'stage'} onFocusIndex={setFocusIndex} onKeyDown={onKeyDown} onActive={grid ? undefined : setActive} />
        ))}
      </div>
      {!grid && <p className="nx-sr-only">Use arrow keys to move between workspaces and Enter to open one.</p>}
    </section>
  );
}
