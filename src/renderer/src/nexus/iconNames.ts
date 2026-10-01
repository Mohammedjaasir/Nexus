// Pure: the icon vocabulary Nexus uses. Kept free of the lucide import so pure
// modules (registry, prompts) and node tests can reference names without React.
export const NEXUS_ICON_NAMES = [
  'home', 'workspaces', 'projects', 'artifacts', 'handoffs', 'deployments',
  'files', 'agents', 'integrations', 'settings', 'search', 'sun', 'moon',
  'assistant', 'panel', 'chevronRight', 'chevronLeft', 'more', 'send', 'plus',
  'import', 'refresh', 'lock', 'check', 'circle', 'close', 'sparkles',
  'sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops', 'yourProjects',
  'dataset', 'appBox', 'rocket', 'help'
] as const;
export type NexusIconName = (typeof NEXUS_ICON_NAMES)[number];

export const HUES = ['violet', 'blue', 'orange', 'teal', 'green', 'amber', 'pink', 'slate'] as const;
export type Hue = (typeof HUES)[number];
