import type { HarnessConfig } from '@/store/config';
import { ShellActionsContext, type ShellActions } from './shellActions';
import { TopBar } from './chrome/TopBar';
import { Sidebar } from './chrome/Sidebar';
import { MobileNav } from './chrome/MobileNav';
import { RouteView } from './routes/RouteView';
import { useProjectsLoader } from './data/useProjects';

export function NexusShell({ config, actions }: { config: HarnessConfig; actions: ShellActions }) {
  useProjectsLoader();
  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="nx-shell">
        <a className="nx-skip nx-focusable" href="#nx-main" onClick={(e) => { e.preventDefault(); document.getElementById('nx-main')?.focus(); }}>Skip to content</a>
        <TopBar />
        <Sidebar />
        <RouteView config={config} />
        <aside className="nx-assistant-slot" aria-label="Assistant" />
        <MobileNav />
      </div>
    </ShellActionsContext.Provider>
  );
}
