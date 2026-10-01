// plannedContent.ts
import type { NexusIconName } from '../iconNames';
export interface PlannedContent { title: string; icon: NexusIconName; what: string; fits: string; today: string; todayAction: 'files' | 'projects' | 'assistant' | 'agents' }
export const PLANNED: Record<'artifacts' | 'handoffs' | 'deployments', PlannedContent> = {
  artifacts: {
    title: 'Artifacts', icon: 'artifacts',
    what: 'Datasets, models, APIs, dashboards and designs as versioned objects, each tied to real files in a project, with history of what it was made from and where it is used.',
    fits: 'Artifacts are what a workspace produces and what other workspaces build on.',
    today: "Your agents' outputs are files in your projects. Open Files or a project to work with them.", todayAction: 'files'
  },
  handoffs: {
    title: 'Handoffs', icon: 'handoffs',
    what: 'Send an artifact version from one workspace to another with a request — for example a model from ML to SDE to wrap in an API — then track it to delivery.',
    fits: 'Handoffs connect workspaces so work flows from data to model to app to deployment.',
    today: 'Ask your lead agent to coordinate work between agents.', todayAction: 'assistant'
  },
  deployments: {
    title: 'Deployments', icon: 'deployments',
    what: 'Build, run and publish what you made, with environments, logs, URLs and rollback.',
    fits: 'Deployment is the last step of the loop: work, artifact, handoff, app, deploy.',
    today: 'Your agents can run build and test commands inside a project.', todayAction: 'agents'
  }
};
