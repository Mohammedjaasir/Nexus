import type { ReactNode } from 'react';
import type { ProjectTool } from '../router/routes';
import { navigate } from '../router/useRoute';
import { useShellActions } from '../shellActions';
import { Icon, type NexusIconName } from '../icons';

const ROUTES: { tool: ProjectTool; label: string; icon: NexusIconName }[] = [
  { tool: 'bench', label: 'Bench', icon: 'bench' },
  { tool: 'changes', label: 'Changes', icon: 'changes' },
  { tool: 'plan', label: 'Plan', icon: 'plan' },
  { tool: 'runs', label: 'Runs', icon: 'runs' }
];

/** Vertical project tools: the routed tools, then the two app actions. */
export function ToolRail({ projectId, rootPath, tool, hasChanges, onOpenTerminal, extra }: { extra?: ReactNode; projectId: string; rootPath: string; tool: ProjectTool; hasChanges: boolean; onOpenTerminal: () => void }) {
  const actions = useShellActions();
  const items = ROUTES.filter((r) => r.tool !== 'changes' || hasChanges || tool === 'changes');
  return (
    <nav className="nx-rail" aria-label="Project tools">
      {items.map((r) => (
        <button key={r.tool} type="button" className="nx-rail__item" title={r.label} aria-label={r.label}
          aria-current={r.tool === tool ? 'page' : undefined}
          onClick={() => navigate({ name: 'project', id: projectId, tool: r.tool })}>
          <Icon name={r.icon} size={17} />
        </button>
      ))}
      <span className="nx-rail__sep" data-desktop-only aria-hidden="true" />
      <button type="button" className="nx-rail__item" data-desktop-only title="Files" aria-label="Open files" onClick={() => actions.openIde(rootPath)}>
        <Icon name="files" size={17} />
      </button>
      <button type="button" className="nx-rail__item" data-desktop-only title="Terminal" aria-label="Open terminal" onClick={onOpenTerminal}>
        <Icon name="terminal" size={17} />
      </button>
      {extra}
    </nav>
  );
}
