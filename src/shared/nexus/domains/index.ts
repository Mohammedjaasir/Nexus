// The domain registry: six first-class domains and three registry-only entries,
// frozen. registryCheck.ts holds the boot checks and the projections.

import type { DomainSpec } from '../domainSpec';
import { SDE } from './sde';
import { QA } from './qa';
import { DATA } from './data';
import { DATA_SCIENTIST } from './dataScientist';
import { ML } from './ml';
import { DL } from './dl';
import { DEVOPS, RESEARCH, UIUX } from './registryOnly';
import { deepFreeze } from '../freeze';

/** In display order. */
export const DOMAINS: readonly DomainSpec[] = deepFreeze(
  [SDE, ML, DL, DATA, RESEARCH, QA, UIUX, DEVOPS, DATA_SCIENTIST].sort((a, b) => a.order - b.order));

export function getDomain(id: string): DomainSpec | null {
  return DOMAINS.find((d) => d.id === id) ?? null;
}
