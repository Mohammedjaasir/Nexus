import { AGENT_OBSERVABILITY_ENV_KEYS } from "./drivers/agent-observability.js";
/** Names minted by the controller from the resolved task configuration.
 * Values remain in the process environment, never in argv or this manifest.
 * Do not mint this projection from ambient process.env.
 */
export const CONFIGURED_ENVIRONMENT_KEYS = "NEXUS_CONFIGURED_ENV_KEYS";

export const GENERATED_RUNTIME_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  CONFIGURED_ENVIRONMENT_KEYS,
  ...AGENT_OBSERVABILITY_ENV_KEYS,
  "NEXUS_AGENT_ID", "NEXUS_AGENT_KEY_ID", "NEXUS_AGENT_PUBLIC_KEY", "NEXUS_AGENT_PRIVATE_KEY",
  "NEXUS_API_KEY", "NEXUS_API_URL", "NEXUS_API_BRIDGE_MODE", "NEXUS_COMPANY_ID", "NEXUS_INSTANCE_ID",
  "NEXUS_RUNTIME_NOTIFICATION_HELPER", "NEXUS_RUNTIME_NOTIFICATION_CONTEXT", "NEXUS_RUN_ID", "NEXUS_NORMALIZED_SESSION_ID", "NEXUS_RUNNER_INSTANCE_ID", "NEXUS_RUNNER_BOOTSTRAP_TICKET", "NEXUS_TASK_ID", "NEXUS_APPROVAL_ID", "NEXUS_APPROVAL_STATUS", "NEXUS_LINKED_ISSUE_IDS",
  "NEXUS_WAKE_REASON", "NEXUS_WAKE_COMMENT_ID", "NEXUS_WAKE_PAYLOAD_JSON", "NEXUS_EXECUTION_MODE",
  "NEXUS_WORKSPACES_JSON", "NEXUS_WORKSPACE_ID", "NEXUS_WORKSPACE_CWD", "NEXUS_WORKSPACE_SOURCE",
  "NEXUS_WORKSPACE_REPO_URL", "NEXUS_WORKSPACE_REPO_REF", "NEXUS_WORKSPACE_BRANCH",
  "NEXUS_WORKSPACE_WORKTREE_PATH", "NEXUS_WORKSPACE_REALIZATION_MODE", "NEXUS_WORKSPACE_AUTHORITATIVE_ROOT",
  "NEXUS_RUNTIME_PRIMARY_URL", "NEXUS_RUNTIME_SERVICES_JSON", "NEXUS_RUNTIME_SERVICE_INTENTS_JSON",
  "NEXUS_AGENT_MESSAGE_KEY", "NEXUS_HARNESS_CHECKOUT_KEY", "NEXUS_EXTERNAL_CHAT_EXECUTION_BOUND_KEY",
  "NEXUS_NATIVE_MCP_STDIO", "NEXUS_NATIVE_MCP_PROXY",
  "NEXUS_NATIVE_MCP_NAME", "NEXUS_NATIVE_MCP_URL", "NEXUS_NATIVE_MCP_TOKEN", "NEXUS_AI_PROVIDER_KEY",
  "NEXUS_PROVIDER_TRACE_PATH", "NEXUS_PROVIDER_TRACE_MAX_BYTES", "NEXUS_ACPX_CREDENTIAL_BINDING",
  "NEXUS_RUNNER_NETWORK_ACCESS", "NEXUS_RUNNER_NETWORK_ROOTS", "NEXUS_RUNNER_EXTERNAL_SANDBOX",
  "NEXUS_GITHUB_AUTH_MODE", "NEXUS_GITHUB_HOST_HOME", "NEXUS_GIT_METADATA_ROOTS",
  "NEXUS_GITHUB_BROKER_TOKEN", "NEXUS_GITHUB_BROKER_URL", "NEXUS_GITHUB_BRIDGE_TOKEN", "NEXUS_GITHUB_LAUNCHER_DIR",
]);

const RESERVED_KEYS = new Set([
  "PATH", "HOME", "USERPROFILE", "CODEX_HOME", "AGENT_HOME", "SHELL", "NODE_OPTIONS", "NODE_PATH",
  "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "BASH_ENV", "ENV", "ZDOTDIR", "GH_CONFIG_DIR",
  "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK", "OPENROUTER_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN",
  "COPILOT_GITHUB_TOKEN", "KIMI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "NEXUS_GIT_TOKEN",
]);

function eligibleKey(key: string): boolean {
  const upper = key.toUpperCase();
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
    && !GENERATED_RUNTIME_ENVIRONMENT_KEYS.has(upper)
    && !RESERVED_KEYS.has(upper)
    && !/^(?:LD_|DYLD_|GIT_CONFIG_|NEXUS_(?:RUNNER_|NATIVE_|GITHUB_|ACPX_|VERIFIED_))/.test(upper);
}

function checkedNames(names: unknown): string[] {
  if (!Array.isArray(names) || names.length > 128 || names.some(name => typeof name !== "string" || !eligibleKey(name))
    || new Set(names).size !== names.length) throw new Error("Invalid configured environment projection");
  return (names as string[]).sort();
}

/** Mint at the server's resolved configuration boundary, before host inheritance. */
export function configuredEnvironmentProjection(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = checkedNames(Object.keys(source).filter(key => source[key] !== undefined && eligibleKey(key)));
  return configuredEnvironment({ ...source, [CONFIGURED_ENVIRONMENT_KEYS]: JSON.stringify(names) });
}

/** Accept only an explicitly supplied, controller-minted projection. */
export function configuredEnvironment(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const raw = source?.[CONFIGURED_ENVIRONMENT_KEYS];
  if (raw === undefined) return {};
  if (Buffer.byteLength(raw) > 20_000) throw new Error("Invalid configured environment projection");
  let names: string[];
  try { names = checkedNames(JSON.parse(raw)); } catch { throw new Error("Invalid configured environment projection"); }
  const result: NodeJS.ProcessEnv = {};
  let bytes = 0;
  for (const name of names) {
    const value = source?.[name];
    if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid configured environment value");
    const size = Buffer.byteLength(name) + Buffer.byteLength(value);
    bytes += size;
    if (size > 65_536 || bytes > 262_144) throw new Error("Configured environment exceeds its bounded launch size");
    result[name] = value;
  }
  result[CONFIGURED_ENVIRONMENT_KEYS] = JSON.stringify(names);
  return result;
}

export function configuredEnvironmentKeys(source: NodeJS.ProcessEnv | undefined): string[] {
  return Object.keys(configuredEnvironment(source)).filter(key => key !== CONFIGURED_ENVIRONMENT_KEYS).sort();
}
