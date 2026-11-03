export type NexusSemanticActionId =
  | "search_api"
  | "call_api"
  | "set_task_title"
  | "send_chat_message"
  | "set_task_monitor"
  | "get_task_context"
  | "get_task_history"
  | "list_documents"
  | "read_document"
  | "list_document_revisions"
  | "report_progress"
  | "answer_status_question"
  | "write_document"
  | "request_human_input"
  | "register_deliverable"
  | "finish_task"
  | "block_task"
  | "request_review"
  | "list_agents"
  | "hire_agent"
  | "get_agent"
  | "search_tasks"
  | "list_approvals"
  | "get_approval"
  | "get_approval_context"
  | "get_workspace_runtime"
  | "control_workspace_service"
  | "reassign_task"
  | "set_dependencies"
  | "create_skill"
  | "update_skill"
  | "get_workspace"
  | "list_workspaces"
  | "select_workspace"
  | "prepare_repository"
  | "create_project"
  | "list_project_repositories"
  | "list_projects"
  | "create_task"
  | "handoff_case"
  | "read_case"
  | "update_case"
  | "create_case"
  | "list_workflows"
  | "read_workflow"
  | "create_workflow"
  | "update_workflow"
  | "request_approval"
  | "decide_approval"
  | "comment_on_approval"
  | "schedule_wake";

export type NexusSemanticActionPlacement = "always" | "optional";
export type NexusSemanticActionMode =
  "standard" | "ask" | "planning" | "skill_test";
export type NexusSemanticActionEffect = "read" | "write" | "governance";

export type NexusJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly NexusJsonValue[]
  | { readonly [key: string]: NexusJsonValue };

/** The JSON Schema subset used by the v1 semantic action catalog. */
export interface NexusJsonSchema {
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, NexusJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | NexusJsonSchema;
  readonly items?: NexusJsonSchema;
  readonly enum?: readonly NexusJsonValue[];
  readonly const?: NexusJsonValue;
  readonly oneOf?: readonly NexusJsonSchema[];
  readonly anyOf?: readonly NexusJsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly pattern?: string;
  readonly format?: string;
  readonly default?: NexusJsonValue;
}

/**
 * A transport-neutral declaration. Catalog membership never grants discovery
 * or invocation authority; a run-scoped authorization layer must do that.
 */
export interface NexusSemanticActionDescriptor {
  readonly schema: "nexus.semantic-action.v1";
  readonly operationId: NexusSemanticActionId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly placement: NexusSemanticActionPlacement;
  readonly effect: NexusSemanticActionEffect;
  readonly requiredClaims: readonly string[];
  readonly allowedModes: readonly NexusSemanticActionMode[];
  readonly allowedRoles?: readonly string[];
  readonly inputSchema: NexusJsonSchema;
  readonly outputSchema: NexusJsonSchema;
}
