import type { DomainId } from '@shared/domain';
import type { LauncherShortcut, WorkspaceConfig } from './types';

export { WORKSPACE_IDS } from './types';
export type { WorkspaceConfig, WorkspaceId, LauncherShortcut, IslandPoint } from './types';

/** Adding a workspace = adding an entry here (and an icon name if new).
 *  Launcher, grid, palette, filters and mapping all read this list. */
const ENTRIES: WorkspaceConfig[] = [
  {
    id: 'sde', label: 'SDE', name: 'Software Engineering', tagline: 'Code · APIs · Build',
    description: 'Write, review and ship code, services and APIs with your agents.',
    icon: 'sde', hueSlot: 0, hue: 'violet',
    domainIds: ['software-engineering', 'web-app-dev', 'mobile-dev', 'game-dev', 'embedded-systems', 'robotics-iot', 'blockchain-web3', 'automation-rpa'],
    defaultDomainId: 'software-engineering', island: { x: 20, y: 32 }, order: 1,
    plannedModules: ['Repositories', 'APIs', 'Builds']
  },
  {
    id: 'ml', label: 'ML', name: 'Machine Learning', tagline: 'Datasets · Models · Deploy',
    description: 'Prepare data, train and evaluate models, and get them ready to serve.',
    icon: 'ml', hueSlot: 1, hue: 'blue', domainIds: ['ai-ml'], defaultDomainId: 'ai-ml',
    island: { x: 50, y: 22 }, order: 2, plannedModules: ['Datasets', 'Experiments', 'Models']
  },
  {
    id: 'dl', label: 'DL', name: 'Deep Learning', tagline: 'Training · Experiments',
    description: 'Run training jobs, compare experiments and manage checkpoints.',
    icon: 'dl', hueSlot: 2, hue: 'orange', domainIds: ['computer-vision'], defaultDomainId: 'computer-vision',
    island: { x: 80, y: 32 }, order: 3, plannedModules: ['Training runs', 'Checkpoints', 'Evaluations']
  },
  {
    id: 'data', label: 'Data Analytics', name: 'Data Analytics', tagline: 'Dashboards · Insights',
    description: 'Query data, build dashboards and turn analysis into reports.',
    icon: 'data', hueSlot: 3, hue: 'teal', domainIds: ['data-analytics', 'data-science', 'gis-geospatial'], defaultDomainId: 'data-analytics',
    island: { x: 86, y: 58 }, order: 4, plannedModules: ['Data sources', 'Queries', 'Dashboards']
  },
  {
    id: 'research', label: 'Research', name: 'Research', tagline: 'Explore · Innovate',
    description: 'Investigate ideas, run studies and write up findings.',
    icon: 'research', hueSlot: 4, hue: 'green', domainIds: ['research-scientific'], defaultDomainId: 'research-scientific',
    island: { x: 14, y: 58 }, order: 5, plannedModules: ['Notes', 'Studies', 'Papers']
  },
  {
    id: 'qa', label: 'QA', name: 'Quality Assurance', tagline: 'Test · Automate',
    description: 'Plan and automate tests, and track quality across projects.',
    icon: 'qa', hueSlot: 5, hue: 'amber', domainIds: [],
    island: { x: 26, y: 84 }, order: 6, plannedModules: ['Test plans', 'Test runs', 'Reports']
  },
  {
    id: 'uiux', label: 'UI / UX', name: 'UI / UX Design', tagline: 'Design · Prototype',
    description: 'Design interfaces, build prototypes and maintain design systems.',
    icon: 'uiux', hueSlot: 6, hue: 'pink', domainIds: [],
    island: { x: 74, y: 84 }, order: 7, plannedModules: ['Designs', 'Prototypes', 'Design systems']
  },
  {
    id: 'devops', label: 'DevOps', name: 'DevOps', tagline: 'Deploy · Monitor',
    description: 'Manage environments, pipelines and the services you run.',
    icon: 'devops', hueSlot: 7, hue: 'slate', domainIds: ['devops-cloud'], defaultDomainId: 'devops-cloud',
    island: { x: 50, y: 86 }, order: 8, plannedModules: ['Environments', 'Pipelines', 'Monitoring']
  }
];

export const WORKSPACES: WorkspaceConfig[] = [...ENTRIES].sort((a, b) => a.order - b.order);

export const LAUNCHER_SHORTCUTS: LauncherShortcut[] = [
  { id: 'projects', label: 'Your Projects', tagline: 'Everything you have open', icon: 'yourProjects', island: { x: 50, y: 56 } }
];

/** Domains deliberately without a workspace in phase A. Their projects show
 *  as "Unassigned" — listed, never hidden. */
export const UNMAPPED_DOMAINS: DomainId[] = ['cybersecurity'];

export function getWorkspace(id: string): WorkspaceConfig | null {
  return WORKSPACES.find((w) => w.id === id) ?? null;
}
