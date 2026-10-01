import { WORKSPACE_IDS, type WorkspaceId } from '../workspaces/types';

export type Route =
  | { name: 'home' }
  | { name: 'workspaces' }
  | { name: 'workspace'; id: WorkspaceId }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'artifacts' }
  | { name: 'handoffs' }
  | { name: 'deployments' }
  | { name: 'agents' }
  | { name: 'not-found'; path: string };

const SIMPLE = ['workspaces', 'projects', 'artifacts', 'handoffs', 'deployments', 'agents'] as const;

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
  if (parts.length === 2) {
    const id = decode(parts[1]);
    if (!id) return notFound;
    if (parts[0] === 'w') return (WORKSPACE_IDS as readonly string[]).includes(id) ? { name: 'workspace', id: id as WorkspaceId } : notFound;
    if (parts[0] === 'p') return { name: 'project', id };
  }
  return notFound;
}

export function formatRoute(r: Route): string {
  switch (r.name) {
    case 'home': return '#/';
    case 'workspace': return `#/w/${encodeURIComponent(r.id)}`;
    case 'project': return `#/p/${encodeURIComponent(r.id)}`;
    case 'not-found': return `#${r.path}`;
    default: return `#/${r.name}`;
  }
}

const TITLES: Record<string, string> = {
  home: 'Home', workspaces: 'Workspaces', projects: 'Projects', project: 'Project',
  artifacts: 'Artifacts', handoffs: 'Handoffs', deployments: 'Deployments', agents: 'Agents', 'not-found': 'Not found'
};

export function routeTitle(r: Route): string {
  if (r.name === 'workspace') {
    const label: Record<WorkspaceId, string> = { sde: 'SDE', ml: 'ML', dl: 'DL', data: 'Data Analytics', research: 'Research', qa: 'QA', uiux: 'UI / UX', devops: 'DevOps' };
    return `${label[r.id]} workspace`;
  }
  return TITLES[r.name];
}

export function routesEqual(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}
