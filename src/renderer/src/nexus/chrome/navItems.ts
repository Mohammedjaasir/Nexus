import type { NexusIconName } from '../iconNames';
import type { Route } from '../router/routes';
import type { ShellActions } from '../shellActions';

export interface NavItem {
  id: string;
  label: string;
  icon: NexusIconName;
  route?: Route;
  action?: keyof ShellActions;
  planned?: boolean;
}

export const NAV_MAIN: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home', route: { name: 'home' } },
  { id: 'workspaces', label: 'Workspaces', icon: 'workspaces', route: { name: 'workspaces' } },
  { id: 'projects', label: 'Projects', icon: 'projects', route: { name: 'projects' } },
  { id: 'artifacts', label: 'Artifacts', icon: 'artifacts', route: { name: 'artifacts' }, planned: true },
  { id: 'handoffs', label: 'Handoffs', icon: 'handoffs', route: { name: 'handoffs' }, planned: true },
  { id: 'deployments', label: 'Deployments', icon: 'deployments', route: { name: 'deployments' }, planned: true }
];

export const NAV_RESOURCES: NavItem[] = [
  { id: 'files', label: 'Files', icon: 'files', action: 'openIde' },
  { id: 'agents', label: 'Agents', icon: 'agents', route: { name: 'agents' } },
  { id: 'integrations', label: 'Integrations', icon: 'integrations', action: 'openSettings' },
  { id: 'settings', label: 'Settings', icon: 'settings', action: 'openSettings' }
];

/** Which nav item a route highlights (workspace → Workspaces, project → Projects). */
export function activeNavId(r: Route): string | null {
  switch (r.name) {
    case 'workspace': return 'workspaces';
    case 'project': return 'projects';
    case 'not-found': return null;
    default: return r.name;
  }
}
