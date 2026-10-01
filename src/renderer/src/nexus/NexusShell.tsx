import { useEffect, useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import { Sheet } from './ui/Sheet';
import { AssistantPanel } from './assistant/AssistantPanel';
import { useNexusUi } from './state/uiStore';
import { ShellActionsContext, type ShellActions } from './shellActions';
import { TopBar } from './chrome/TopBar';
import { Sidebar } from './chrome/Sidebar';
import { MobileNav } from './chrome/MobileNav';
import { RouteView } from './routes/RouteView';
import { useProjectsLoader } from './data/useProjects';

export function NexusShell({ config, actions }: { config: HarnessConfig; actions: ShellActions }) {
  useProjectsLoader();
  const compact = useIsCompact();
  return (
    <ShellActionsContext.Provider value={actions}>
      <div className="nx-shell">
        <a className="nx-skip nx-focusable" href="#nx-main" onClick={(e) => { e.preventDefault(); document.getElementById('nx-main')?.focus(); }}>Skip to content</a>
        <TopBar />
        <Sidebar />
        <RouteView config={config} />
        {/* Exactly one assistant panel is mounted: the column on wide layouts,
            the sheet below 1280px (two would duplicate ids and polling). */}
        {!compact && <aside className="nx-assistant-slot" aria-labelledby="nx-assist-col"><AssistantPanel headingId="nx-assist-col" /></aside>}
        {compact && <CompactAssistant />}
        <MobileNav />
      </div>
    </ShellActionsContext.Provider>
  );
}

function useIsCompact(): boolean {
  const q = '(max-width: 1279px)';
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const on = () => setM(mq.matches); mq.addEventListener('change', on); return () => mq.removeEventListener('change', on); }, []);
  return m;
}

function CompactAssistant() {
  const open = useNexusUi((s) => s.assistantOpen);
  const setOpen = useNexusUi((s) => s.setAssistantOpen);
  const bottom = window.matchMedia('(max-width: 639px)').matches;
  return <Sheet open={open} onClose={() => setOpen(false)} side={bottom ? 'bottom' : 'right'} labelledBy="nx-assist-sheet"><AssistantPanel headingId="nx-assist-sheet" /></Sheet>;
}
