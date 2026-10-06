// Live workspace catalogue for the main process. It deliberately imports nothing
// from the renderer or from shared/domain.ts. The renderer registry stays the
// owner of presentation; test/nexus-core-workspace-catalog.test.cjs pins this
// mapping to it.

export const PLATFORM_WORKSPACE_IDS = ['sde', 'ml', 'dl', 'data', 'research', 'qa', 'uiux', 'devops'] as const;
export type PlatformWorkspaceId = (typeof PLATFORM_WORKSPACE_IDS)[number];

export const LEGACY_DOMAIN_TO_WORKSPACE: Readonly<Record<string, PlatformWorkspaceId>> = Object.freeze({
  'software-engineering': 'sde',
  'web-app-dev': 'sde',
  'mobile-dev': 'sde',
  'game-dev': 'sde',
  'embedded-systems': 'sde',
  'robotics-iot': 'sde',
  'blockchain-web3': 'sde',
  'automation-rpa': 'sde',
  'ai-ml': 'ml',
  'computer-vision': 'dl',
  'data-analytics': 'data',
  'data-science': 'data',
  'gis-geospatial': 'data',
  'research-scientific': 'research',
  'devops-cloud': 'devops'
});

export function workspaceForLegacyDomain(domainId: string | null | undefined): PlatformWorkspaceId | null {
  if (!domainId) return null;
  return Object.prototype.hasOwnProperty.call(LEGACY_DOMAIN_TO_WORKSPACE, domainId)
    ? LEGACY_DOMAIN_TO_WORKSPACE[domainId]
    : null;
}

export function isPlatformWorkspaceId(id: unknown): id is PlatformWorkspaceId {
  return typeof id === 'string' && (PLATFORM_WORKSPACE_IDS as readonly string[]).includes(id);
}
