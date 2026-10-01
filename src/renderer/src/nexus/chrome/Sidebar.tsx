import { Icon } from '../icons';
import { navigate, useRoute } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { useNexusUi } from '../state/uiStore';
import { NAV_MAIN, NAV_RESOURCES, activeNavId, type NavItem } from './navItems';
import { SetupCard } from './SetupCard';

export function Sidebar() {
  const route = useRoute();
  const active = activeNavId(route);
  const actions = useShellActions();
  const expanded = useNexusUi((s) => s.railExpanded);
  const setExpanded = useNexusUi((s) => s.setRailExpanded);
  const focusComposer = useNexusUi((s) => s.focusComposer);

  const run = (item: NavItem) => {
    if (item.route) { navigate(item.route); return; }
    if (item.id === 'integrations') { actions.openSettings('Connections'); return; }
    if (item.action === 'openSettings') { actions.openSettings(); return; }
    if (item.action) actions[item.action]();
  };

  const renderItem = (item: NavItem) => (
    <li key={item.id}>
      <button
        type="button"
        className={`nx-nav__item nx-focusable${active === item.id ? ' is-active' : ''}`}
        aria-current={active === item.id ? 'page' : undefined}
        onClick={() => run(item)}
        title={item.label}
      >
        <Icon name={item.icon} size={19} />
        <span className="nx-nav__label">{item.label}</span>
        {item.planned && <span className="nx-nav__soon">Soon</span>}
      </button>
    </li>
  );

  return (
    <nav
      className={`nx-sidebar${expanded ? ' is-expanded' : ''}`}
      aria-label="Main"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setExpanded(false); }}
    >
      <ul className="nx-nav">{NAV_MAIN.map(renderItem)}</ul>
      <div className="nx-nav__heading">Resources</div>
      <ul className="nx-nav">{NAV_RESOURCES.map(renderItem)}</ul>
      <div className="nx-sidebar__foot">
        <SetupCard />
        <button type="button" className="nx-help nx-focusable" onClick={focusComposer}>
          <Icon name="help" size={18} />
          <span><strong>Need help?</strong><br />Ask your lead agent</span>
        </button>
      </div>
    </nav>
  );
}
