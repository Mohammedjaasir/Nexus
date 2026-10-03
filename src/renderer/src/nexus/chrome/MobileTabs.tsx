import { Icon } from '../icons';
import type { NexusIconName } from '../iconNames';
import { navigate, useRoute } from '../router/useRoute';
import type { Route } from '../router/routes';
import { useNexusUi } from '../state/uiStore';

const TABS: { id: string; label: string; icon: NexusIconName; route: Route }[] = [
  { id: 'home', label: 'Home', icon: 'home', route: { name: 'home' } },
  { id: 'projects', label: 'Projects', icon: 'projects', route: { name: 'projects' } },
  { id: 'agents', label: 'Agents', icon: 'agents', route: { name: 'agents' } }
];

/** Bottom tabs below 768px (CSS shows them only there). */
export function MobileTabs() {
  const route = useRoute();
  const setPaletteOpen = useNexusUi((s) => s.setPaletteOpen);
  const active = route.name === 'project' ? 'projects' : route.name;
  return (
    <nav aria-label="Main" className="nx-tabs">
      {TABS.map((t) => (
        <button key={t.id} type="button" className={`nx-tabs__item${active === t.id ? ' is-active' : ''}`}
          aria-current={active === t.id ? 'page' : undefined} onClick={() => navigate(t.route)}>
          <Icon name={t.icon} size={20} /><span>{t.label}</span>
        </button>
      ))}
      <button type="button" className="nx-tabs__item" aria-haspopup="dialog" onClick={() => setPaletteOpen(true)}>
        <Icon name="search" size={20} /><span>Search</span>
      </button>
    </nav>
  );
}
