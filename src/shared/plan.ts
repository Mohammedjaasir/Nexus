/**
 * Shared types for Project Planning & Task Graph in Munder Difflin (Phase 8A).
 */

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'needs_review';

export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface ProjectTask {
  taskId: string;
  projectId: string;
  milestoneId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dependencies: string[]; // List of prerequisite taskId strings
  suggestedRoleId: string;
  verificationRules: string[];
  relevantGraphNodeIds: string[];
  createdAt: number;
  updatedAt: number;
}

export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface ProjectMilestone {
  milestoneId: string;
  projectId: string;
  title: string;
  description: string;
  order: number;
  status: MilestoneStatus;
  taskIds: string[];
}

export interface ProjectPlanProgress {
  totalMilestones: number;
  completedMilestones: number;
  totalTasks: number;
  completedTasks: number;
  readyTasks: number;
  blockedTasks: number;
  failedTasks: number;
  progressPercentage: number;
}

export interface ProjectPlan {
  projectId: string;
  projectName: string;
  domainId: string;
  milestones: ProjectMilestone[];
  tasks: ProjectTask[];
  progress: ProjectPlanProgress;
  createdAt: number;
  updatedAt: number;
}
