import { useAppTheme, toggleAppTheme } from '@/design/theme';
import { UpdateBadge } from '@/components/UpdateBadge';
import { Icon } from '../icons';
import { useNexusUi } from '../state/uiStore';
import { useShellActions } from '../shellActions';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function TopBar() {
  const theme = useAppTheme();
  const setPaletteOpen = useNexusUi((s) => s.setPaletteOpen);
  const toggleAssistant = useNexusUi((s) => s.toggleAssistant);
  const actions = useShellActions();
  return (
    <header className={`nx-topbar cth-titlebar-drag${IS_MAC ? ' nx-topbar--mac' : ''}`}>
      <a className="nx-brand cth-titlebar-nodrag nx-focusable" href="#/" aria-label="Nexus home">
        <span className="nx-brand__mark" aria-hidden="true" />
        <span className="nx-brand__name">Nexus</span>
        <span className="nx-brand__beta">Beta</span>
      </a>
      <button type="button" className="nx-search cth-titlebar-nodrag nx-focusable" onClick={() => setPaletteOpen(true)} aria-label="Search projects, workspaces and pages">
        <Icon name="search" size={16} />
        <span className="nx-search__text">Search projects, workspaces, pages…</span>
        <kbd className="nx-search__kbd">{IS_MAC ? '⌘ K' : 'Ctrl K'}</kbd>
      </button>
      <div className="nx-topbar__right cth-titlebar-nodrag">
        <span className="nx-topbar__version"><UpdateBadge /></span>
        <button type="button" className="nx-iconbtn nx-focusable nx-only-compact" onClick={toggleAssistant} aria-label="Toggle assistant" title="Assistant (Ctrl/⌘ J)">
          <Icon name="assistant" />
        </button>
        <button
          type="button"
          className="nx-iconbtn nx-focusable"
          onClick={() => { const next = toggleAppTheme(); void window.cth.updateConfig({ terminalTheme: next }); }}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        <button type="button" className="nx-iconbtn nx-focusable" onClick={() => actions.openSettings()} aria-label="Settings" title="Settings">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
