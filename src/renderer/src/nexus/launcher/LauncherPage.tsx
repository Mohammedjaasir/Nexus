import { useMemo, useState } from 'react';
import { WORKSPACES } from '../workspaces/registry';
import { entriesFromRegistry } from './indexModel';
import { EnvironmentIndex } from './EnvironmentIndex';
import { EnvironmentPreview } from './EnvironmentPreview';
import { ContinueLine } from './ContinueLine';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import type { WorkspaceId } from '../workspaces/types';

export function LauncherPage() {
  const entries = useMemo(() => entriesFromRegistry(WORKSPACES), []);
  const last = useNexusUi((s) => s.lastWorkspace);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const [activeId, setActiveId] = useState<string | null>(entries.find((e) => e.id === last)?.id ?? entries[0]?.id ?? null);
  const open = (id: string) => { setLast(id); navigate({ name: 'workspace', id: id as WorkspaceId }); };
  return (
    <div className="nx-launcher">
      <div className="nx-launcher__main">
        <ContinueLine />
        <h1 className="nx-launcher__q" tabIndex={-1}>What are you <span>working on?</span></h1>
        <EnvironmentIndex entries={entries} initialId={activeId} onActive={setActiveId} onOpen={open} />
      </div>
      <EnvironmentPreview id={activeId} />
    </div>
  );
}
