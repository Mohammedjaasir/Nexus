import type { HarnessConfig } from '@/store/config';
import { CommandPalette } from './chrome/CommandPalette';
import { useShortcuts } from './chrome/useShortcuts';
import { ShellActionsContext, type ShellActions } from './shellActions';
import { ContextBar } from './chrome/ContextBar';
import { MobileTabs } from './chrome/MobileTabs';
import { RouteView } from './routes/RouteView';
import { useProjectsLoader } from './data/useProjects';

export function NexusShell({ config, actions }: { config: HarnessConfig; actions: ShellActions }) {
  useProjectsLoader();
  useShortcuts();
  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="nx-shell">
        <a className="nx-skip" href="#nx-main" onClick={(e) => { e.preventDefault(); document.getElementById('nx-main')?.focus(); }}>Skip to content</a>
        <ContextBar />
        <RouteView config={config} />
        {/* IntentLine slot: Task 9 mounts it here. */}
        <MobileTabs />
        <CommandPalette />
      </div>
    </ShellActionsContext.Provider>
  );
}
