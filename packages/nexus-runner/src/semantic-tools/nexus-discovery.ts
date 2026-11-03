import { NEXUS_SEMANTIC_ACTION_CATALOG } from "../catalog/semantic-action-catalog.js";
import type {
  NexusSemanticActionDescriptor,
  NexusSemanticActionId,
} from "../catalog/semantic-action-types.js";
import { decideNexusSemanticAuthorization } from "./authorization.js";
import type {
  NexusSemanticDiscoveryResult,
  NexusSemanticRunContext,
  NexusSemanticToolDefinition,
} from "./types.js";

const NAMESPACE: Readonly<Record<NexusSemanticActionId, string>> =
  Object.freeze({
    set_task_title: "active_task",
    send_chat_message: "active_task",
  set_task_monitor: "continuation",
    search_api: "api_fallback",
    call_api: "api_fallback",
    get_task_context: "active_task",
    get_task_history: "active_task",
    list_documents: "documents",
    read_document: "documents",
    list_document_revisions: "documents",
    report_progress: "active_task",
    answer_status_question: "active_task",
    write_document: "documents",
    request_human_input: "documents",
    register_deliverable: "documents",
    finish_task: "active_task",
    block_task: "active_task",
    request_review: "active_task",
    list_agents: "discovery",
    hire_agent: "delegation",
    handoff_case: "delegation",
    read_case: "delegation",
    update_case: "delegation",
    create_case: "delegation",
  list_workflows: "delegation", read_workflow: "delegation", create_workflow: "delegation", update_workflow: "delegation",
    get_agent: "discovery",
    search_tasks: "discovery",
    list_approvals: "governance",
    get_approval: "governance",
    get_approval_context: "governance",
    get_workspace_runtime: "workspace",
    control_workspace_service: "workspace",
    set_dependencies: "delegation", reassign_task: "delegation",
    create_skill: "skills", update_skill: "skills", create_task: "delegation", get_workspace: "workspace", list_workspaces: "workspace", select_workspace: "workspace", prepare_repository: "workspace", create_project: "projects", list_project_repositories: "projects", list_projects: "projects",
    request_approval: "governance",
    decide_approval: "governance",
    comment_on_approval: "governance",
    schedule_wake: "continuation",
  });

export function nexusSemanticActionNamespace(
  operationId: NexusSemanticActionId,
): string {
  return NAMESPACE[operationId];
}

export function projectNexusSemanticTools(input: {
  readonly runId: string;
  readonly context: NexusSemanticRunContext;
  readonly boundOperationIds: ReadonlySet<NexusSemanticActionId>;
  readonly placement?: NexusSemanticActionDescriptor["placement"];
}): readonly NexusSemanticToolDefinition[] {
  return deepFreeze(authorizedBoundDescriptors(input).map(toToolDefinition));
}

export function discoverNexusSemanticTools(input: {
  readonly runId: string;
  readonly context: NexusSemanticRunContext;
  readonly boundOperationIds: ReadonlySet<NexusSemanticActionId>;
  readonly query: string;
  readonly namespace?: string;
  readonly limit?: number;
}): NexusSemanticDiscoveryResult {
  const normalized = input.query.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 500) {
    throw new Error("semantic_discovery_query_invalid");
  }
  const namespace = input.namespace?.trim().toLowerCase();
  if (namespace !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(namespace)) {
    throw new Error("semantic_discovery_namespace_invalid");
  }
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 5), 8));
  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  const candidates = authorizedBoundDescriptors({
    ...input,
    placement: "optional",
  })
    .filter(
      (descriptor) =>
        namespace === undefined ||
        nexusSemanticActionNamespace(descriptor.operationId) === namespace,
    )
    .map((descriptor) => ({
      descriptor,
      score: scoreDescriptor(descriptor, normalized, tokens),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.descriptor.operationId.localeCompare(right.descriptor.operationId),
    );

  return deepFreeze({
    schema: "nexus.semantic-discovery.v1",
    query: input.query,
    namespace: namespace ?? null,
    operations: candidates
      .slice(0, limit)
      .map(({ descriptor }) => toToolDefinition(descriptor)),
    truncated: candidates.length > limit,
  });
}

export function toNexusSemanticToolDefinition(
  descriptor: NexusSemanticActionDescriptor,
): NexusSemanticToolDefinition {
  return deepFreeze(toToolDefinition(descriptor));
}

function authorizedBoundDescriptors(input: {
  readonly runId: string;
  readonly context: NexusSemanticRunContext;
  readonly boundOperationIds: ReadonlySet<NexusSemanticActionId>;
  readonly placement?: NexusSemanticActionDescriptor["placement"];
}): NexusSemanticActionDescriptor[] {
  return NEXUS_SEMANTIC_ACTION_CATALOG.filter(
    (descriptor) =>
      input.boundOperationIds.has(descriptor.operationId) &&
      (input.placement === undefined ||
        descriptor.placement === input.placement) &&
      decideNexusSemanticAuthorization(
        descriptor,
        input.context,
        "exposure",
        input.runId,
      ).allowed,
  );
}

function scoreDescriptor(
  descriptor: NexusSemanticActionDescriptor,
  query: string,
  tokens: readonly string[],
): number {
  const operationId = descriptor.operationId.toLowerCase();
  const namespace = nexusSemanticActionNamespace(descriptor.operationId);
  const haystack =
    `${operationId} ${descriptor.title} ${descriptor.description} ${namespace}`.toLowerCase();
  let score = operationId === query ? 100 : namespace === query ? 50 : 0;
  for (const token of tokens) {
    if (operationId.includes(token)) score += 12;
    if (namespace.includes(token)) score += 8;
    if (haystack.includes(token)) score += 3;
  }
  return score;
}

function toToolDefinition(
  descriptor: NexusSemanticActionDescriptor,
): NexusSemanticToolDefinition {
  return {
    name: descriptor.operationId,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    annotations: {
      semanticContract: descriptor.schema,
      version: descriptor.version,
      placement: descriptor.placement,
      effect: descriptor.effect,
      requiredClaims: descriptor.requiredClaims,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
