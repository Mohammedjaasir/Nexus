// plannedContent.ts
import type { NexusIconName } from '../iconNames';
export interface PlannedContent { title: string; icon: NexusIconName; what: string; fits: string; today: string; todayAction: 'files' | 'projects' | 'assistant' | 'agents' }
export const PLANNED: Record<'deployments', PlannedContent> = {
  deployments: {
    title: 'Deployments', icon: 'deployments',
    what: 'Build, run and publish what you made, with environments, logs, URLs and rollback.',
    fits: 'Deployment is the last step of the loop: work, artifact, handoff, app, deploy.',
    today: 'Your agents can run build and test commands inside a project.', todayAction: 'agents'
  }
};
