import { getWorkspace } from '../workspaces/registry';
import type { WorkspaceId } from '../workspaces/types';

export const PROJECT_TOOLS = ['bench', 'changes', 'completion', 'runs'] as const;
export type ProjectTool = (typeof PROJECT_TOOLS)[number];

export type Route =
  | { name: 'home' }
  | { name: 'browse' }
  | { name: 'workspaces' }
  | { name: 'workspace'; id: WorkspaceId }
  | { name: 'projects' }
  | { name: 'project'; id: string; tool: ProjectTool }
  | { name: 'artifacts' }
  | { name: 'handoffs' }
  | { name: 'deployments' }
  | { name: 'agents' }
  | { name: 'not-found'; path: string };

const SIMPLE = ['browse', 'workspaces', 'projects', 'artifacts', 'handoffs', 'deployments', 'agents'] as const;

function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

export function parseHash(hash: string): Route {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!path.startsWith('/')) path = '/' + path;
  path = path.replace(/\/+$/, '');
  if (path === '') return { name: 'home' };
  const parts = path.slice(1).split('/');
  const notFound: Route = { name: 'not-found', path };
  if (parts.length === 1) {
    const head = parts[0] as (typeof SIMPLE)[number];
    return (SIMPLE as readonly string[]).includes(head) ? ({ name: head } as Route) : notFound;
  }
  if (parts.length === 2 || parts.length === 3) {
    const id = decode(parts[1]);
    if (!id) return notFound;
    if (parts[0] === 'w' && parts.length === 2) return getWorkspace(id) ? { name: 'workspace', id: id as WorkspaceId } : notFound;
    if (parts[0] === 'p') {
      // The old plan tool's links ('#/p/<id>/plan') open Completion.
      const tool = (parts[2] === 'plan' ? 'completion' : parts[2] ?? 'bench') as ProjectTool;
      return (PROJECT_TOOLS as readonly string[]).includes(tool) ? { name: 'project', id, tool } : notFound;
    }
  }
  return notFound;
}

export function formatRoute(r: Route): string {
  switch (r.name) {
    case 'home': return '#/';
    case 'workspace': return `#/w/${encodeURIComponent(r.id)}`;
    case 'project': return r.tool === 'bench' ? `#/p/${encodeURIComponent(r.id)}` : `#/p/${encodeURIComponent(r.id)}/${r.tool}`;
    case 'not-found': return `#${r.path}`;
    default: return `#/${r.name}`;
  }
}

const TITLES: Record<string, string> = {
  home: 'Home', browse: 'Environments', workspaces: 'Workspaces', projects: 'Projects', project: 'Project',
  artifacts: 'Artifacts', handoffs: 'Handoffs', deployments: 'Deployments', agents: 'Agents', 'not-found': 'Not found'
};

const TOOL_TITLES: Record<ProjectTool, string> = { bench: 'Project', changes: 'Changes', completion: 'Completion', runs: 'Runs' };

export function routeTitle(r: Route): string {
  if (r.name === 'workspace') return `${getWorkspace(r.id)?.label ?? r.id} workspace`;
  if (r.name === 'project') return TOOL_TITLES[r.tool];
  return TITLES[r.name];
}

export function routesEqual(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
