import { useMemo, useState, type CSSProperties } from 'react';
import { WORKSPACES, getWorkspace } from '../workspaces/registry';
import { provenanceHue } from '../design/provenance';
import { entriesFromRegistry } from './indexModel';
import { EnvironmentIndex } from './EnvironmentIndex';
import { EnvironmentPreview } from './EnvironmentPreview';
import { ContinueLine } from './ContinueLine';
import { navigate } from '../router/useRoute';
import { useNexusUi } from '../state/uiStore';
import type { WorkspaceId } from '../workspaces/types';

/** The launcher is the one place Nexus lets ambience move (see DESIGN.md,
 *  "Launcher motion exception"). Everything is tinted by `--nx-live-h`, the
 *  hue of the selected environment, which is a registered custom property so
 *  the whole page eases from one environment's colour to the next. */
export function LauncherPage() {
  const entries = useMemo(() => entriesFromRegistry(WORKSPACES), []);
  const last = useNexusUi((s) => s.lastWorkspace);
  const setLast = useNexusUi((s) => s.setLastWorkspace);
  const [activeId, setActiveId] = useState<string | null>(entries.find((e) => e.id === last)?.id ?? entries[0]?.id ?? null);
  const open = (id: string) => { setLast(id); navigate({ name: 'workspace', id: id as WorkspaceId }); };
  const slot = activeId ? getWorkspace(activeId)?.hueSlot ?? null : null;
  const live = { ['--nx-live-h' as string]: String(slot === null ? 265 : provenanceHue(slot)) } as CSSProperties;
  return (
    <div className="nx-launcher nx-living" style={live}>
      <div className="nx-aurora" aria-hidden="true">
        <span className="nx-aurora__blob nx-aurora__blob--a" />
        <span className="nx-aurora__blob nx-aurora__blob--b" />
        <span className="nx-aurora__blob nx-aurora__blob--c" />
      </div>
      <div className="nx-launcher__main">
        <ContinueLine />
        <h1 className="nx-launcher__q" tabIndex={-1}>What are you <span>working on?</span></h1>
        <EnvironmentIndex entries={entries} initialId={activeId} onActive={setActiveId} onOpen={open} />
      </div>
      <EnvironmentPreview id={activeId} />
    </div>
  );
}
