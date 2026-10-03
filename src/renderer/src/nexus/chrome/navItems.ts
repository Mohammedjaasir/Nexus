import type { NexusIconName } from '../iconNames';
import type { Route } from '../router/routes';
import type { ShellActions } from '../shellActions';
import { getWorkspace } from '../workspaces/registry';
import { workspaceForDomain, UNASSIGNED_LABEL } from '../workspaces/mapping';

export interface NavItem { id: string; label: string; icon: NexusIconName; route?: Route; action?: keyof ShellActions; planned?: boolean }

export const MENU_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Go to', items: [
    { id: 'home', label: 'Home', icon: 'home', route: { name: 'home' } },
    { id: 'workspaces', label: 'Workspaces', icon: 'workspaces', route: { name: 'workspaces' } },
    { id: 'projects', label: 'Projects', icon: 'projects', route: { name: 'projects' } },
    { id: 'agents', label: 'Agents', icon: 'agents', route: { name: 'agents' } }
  ] },
  { label: 'Planned', items: [
    { id: 'artifacts', label: 'Artifacts', icon: 'artifacts', route: { name: 'artifacts' }, planned: true },
    { id: 'handoffs', label: 'Handoffs', icon: 'handoffs', route: { name: 'handoffs' }, planned: true },
    { id: 'deployments', label: 'Deployments', icon: 'deployments', route: { name: 'deployments' }, planned: true }
  ] },
  { label: 'App', items: [
    { id: 'files', label: 'Files', icon: 'files', action: 'openIde' },
    { id: 'integrations', label: 'Integrations', icon: 'integrations', action: 'openSettings' },
    { id: 'settings', label: 'Settings', icon: 'settings', action: 'openSettings' }
  ] }
];

export type PathSegment = { kind: 'workspace' | 'project'; id: string; label: string; hueSlot: number | null };
type P = { id: string; name: string; domainId: string };

export function pathSegments(r: Route, projects: P[]): PathSegment[] {
  if (r.name === 'workspace') {
    const w = getWorkspace(r.id);
    return w ? [{ kind: 'workspace', id: w.id, label: w.label, hueSlot: w.hueSlot }] : [];
  }
  if (r.name === 'project') {
    const p = projects.find((x) => x.id === r.id);
    if (!p) return [];
    const w = workspaceForDomain(p.domainId);
    const ws: PathSegment = w ? { kind: 'workspace', id: w.id, label: w.label, hueSlot: w.hueSlot } : { kind: 'workspace', id: 'unassigned', label: UNASSIGNED_LABEL, hueSlot: null };
    return [ws, { kind: 'project', id: p.id, label: p.name, hueSlot: null }];
  }
  return [];
}
