import { Icon } from '../icons';
import { navigate, useRoute } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import { activeNavId } from './navItems';

export function MobileNav() {
  const route = useRoute();
  const active = activeNavId(route);
  const toggleAssistant = useNexusUi((s) => s.toggleAssistant);
  const assistantOpen = useNexusUi((s) => s.assistantOpen);
  const item = (id: string, label: string, icon: 'home' | 'projects' | 'agents', go: () => void) => (
    <button type="button" className={`nx-bottomnav__item nx-focusable${active === id ? ' is-active' : ''}`} aria-current={active === id ? 'page' : undefined} onClick={go}>
      <Icon name={icon} size={20} /><span>{label}</span>
    </button>
  );
  return (
    <nav className="nx-bottomnav" aria-label="Main">
      {item('home', 'Home', 'home', () => navigate({ name: 'home' }))}
      {item('projects', 'Projects', 'projects', () => navigate({ name: 'projects' }))}
      {item('agents', 'Agents', 'agents', () => navigate({ name: 'agents' }))}
      <button type="button" className={`nx-bottomnav__item nx-focusable${assistantOpen ? ' is-active' : ''}`} onClick={toggleAssistant} aria-expanded={assistantOpen}>
        <Icon name="assistant" size={20} /><span>Assistant</span>
      </button>
    </nav>
  );
}
