import { createHash } from "node:crypto";
import type { ManagedExperimentalFeatureKey } from "@nexusai/shared";

const CLOUD_STAGING_EXPERIMENTAL_KEYS: ReadonlySet<string> = new Set([
  "autoRestartDevServerWhenIdle",
  "enableAgentChat",
  "enableBetaSkills",
  "enableBuiltInAgents",
  "enableCases",
  "enableArtifactsV1",
  "enableChatConnectors",
  "enableClassicTaskInterface",
  "enableCombinedInboxTasks",
  "enableConferenceRoomChat",
  "enableDecisions",
  "enableEnvironments",
  "enableExperimentalFileViewer",
  "enableExternalObjects",
  "enableFastResponses",
  "enableFirstTaskPlanProposal",
  "enableGitHubReviewBots",
  "enableGoalsSidebarLink",
  "enableGrokBot",
  "enableIsolatedWorkspaces",
  "enableIsolatedWorkspacesByDefault",
  "enableIssuePlanDecompositions",
  "enableMemoryConnectors",
  "enableMuse",
  "enableNativeRunner",
  "enableOpenAiDot",
  "enableNexusDeveloperMode",
  "enablePublicMcp",
  "enableServerInfoDebugView",
  "enableSimplifiedEnglishInteractions",
  "enableSmokeLab",
  "enableStatusCards",
  "enableStreamlinedUi",
  "enableSummaries",
  "enableWorktreeRunExecution",
] satisfies ManagedExperimentalFeatureKey[]);

export function isCloudStagingExperimentalSetting(key: string): boolean {
  return CLOUD_STAGING_EXPERIMENTAL_KEYS.has(key);
}

export type CloudInstanceEnv = Record<string, string | undefined>;

export type CloudStackContext = {
  stackId: string | null;
  stackSlug: string | null;
  accountGroupId: string | null;
  primaryHost: string | null;
  cloudOrigin: string | null;
};

function normalizeOptionalEnvValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * The canonical Nexus Cloud instance predicate.
 *
 * The tenant token is the signal injected on live cloud stacks. The managed
 * config document is the legacy/bootstrap signal used by managed feature and
 * plugin floors. Their union is intentionally monotonic: either prior signal
 * keeps every restrictive cloud floor enabled.
 */
export function isCloudManagedInstance(
  env: CloudInstanceEnv = process.env,
): boolean {
  return (
    normalizeOptionalEnvValue(env.NEXUS_CLOUD_TENANT_SERVER_TOKEN) !== null ||
    env.NEXUS_MANAGED_CONFIG !== undefined
  );
}

export function isCloudStagingInstance(env: CloudInstanceEnv = process.env): boolean {
  const host = normalizeOptionalEnvValue(env.NEXUS_PRIMARY_HOST);
  return isCloudManagedInstance(env) && host !== null && /^[a-z0-9-]+\.staging\.paperclip\.app$/i.test(host);
}

/**
 * Public stack metadata injected by the Nexus Cloud provisioner.
 *
 * A managed signal can exist briefly before every metadata value is available,
 * so absent or blank values are represented as null rather than making health
 * checks fail. Self-hosted instances never expose a stack context.
 */
export function getCloudStackContext(
  env: CloudInstanceEnv = process.env,
): CloudStackContext | null {
  if (!isCloudManagedInstance(env)) return null;

  return {
    stackId: normalizeOptionalEnvValue(env.NEXUS_CLOUD_STACK_ID),
    stackSlug: normalizeOptionalEnvValue(env.NEXUS_STACK_SLUG),
    accountGroupId: normalizeOptionalEnvValue(env.NEXUS_CLOUD_ACCOUNT_GROUP_ID),
    primaryHost: normalizeOptionalEnvValue(env.NEXUS_PRIMARY_HOST),
    cloudOrigin: normalizeOptionalEnvValue(env.NEXUS_CLOUD_API_ORIGIN),
  };
}

/**
 * The Cloud-pinned primary company id for a stack: the deterministic
 * v5-style UUID the trusted-header lane seeds and every Cloud surface pins.
 * The derivation is frozen — seeded companies fleet-wide already carry
 * these ids. middleware/auth.ts delegates here; this is the one definition.
 */
export function cloudTenantPrimaryCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`nexus-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
