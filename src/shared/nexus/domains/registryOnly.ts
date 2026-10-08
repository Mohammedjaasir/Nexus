// Registry-only entries: seeded workspaces (v7) that are not supported
// workflows. No lifecycle, no modules, no actions, no recipes.

import type { DomainSpec } from '../domainSpec';

const entry = (id: string, label: string, shortLabel: string, description: string, hueSlot: number, order: number,
  legacyDomainIds: string[]): DomainSpec => ({
  specVersion: 3, id, label, shortLabel, description, tier: 'registry-only', hueSlot, icon: id, order,
  availableFromSubPhase: 'B1', statusNote: 'Not yet a supported workflow.', legacyDomainIds,
  vocabulary: {}, kindsProduced: [], kindsAccepted: [], capabilities: [], recipes: [], skills: [], actions: [],
  lifecycle: [], handoffRoutes: [], completionRules: [], modules: []
});

export const RESEARCH = entry('research', 'Research', 'Research', 'Investigate ideas, run studies and write up findings.', 4, 5,
  ['research-scientific']);
export const UIUX = entry('uiux', 'UI / UX Design', 'UI / UX', 'Design interfaces, build prototypes and maintain design systems.', 6, 7, []);
export const DEVOPS = entry('devops', 'DevOps', 'DevOps', 'Manage environments, pipelines and the services you run.', 7, 8,
  ['devops-cloud']);
