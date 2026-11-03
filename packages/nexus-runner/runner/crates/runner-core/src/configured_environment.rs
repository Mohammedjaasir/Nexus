//! Controller-selected task environment; mirrors configured-environment.ts.
use crate::local_runner::LocalRunnerError;
use std::process::Command;

const MARKER: &str = "NEXUS_CONFIGURED_ENV_KEYS";
const RESERVED: &[&str] = &[
    "NEXUS_OBSERVABILITY_CODEX_CONFIG",
    "NEXUS_OBSERVABILITY_OPENCODE",
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA",
    "ENABLE_ENHANCED_TELEMETRY_BETA",
    "OTEL_LOGS_EXPORTER",
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TIMEOUT",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT",
    "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_LOG_USER_PROMPTS",
    "OTEL_LOG_ASSISTANT_RESPONSES",
    "OTEL_LOG_TOOL_DETAILS",
    "OTEL_LOG_TOOL_CONTENT",
    "OTEL_LOG_RAW_API_BODIES",
    "AGENT_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "BASH_ENV",
    "ZDOTDIR",
    "GH_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "COPILOT_GITHUB_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "ENV",
    "GH_ENTERPRISE_TOKEN",
    "GH_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "HOME",
    "KIMI_API_KEY",
    "NODE_OPTIONS",
    "NODE_PATH",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "NEXUS_ACPX_CREDENTIAL_BINDING",
    "NEXUS_AGENT_ID",
    "NEXUS_AGENT_KEY_ID",
    "NEXUS_AGENT_MESSAGE_KEY",
    "NEXUS_AGENT_PRIVATE_KEY",
    "NEXUS_AGENT_PUBLIC_KEY",
    "NEXUS_AI_PROVIDER_KEY",
    "NEXUS_API_BRIDGE_MODE",
    "NEXUS_API_KEY",
    "NEXUS_API_URL",
    "NEXUS_APPROVAL_ID",
    "NEXUS_APPROVAL_STATUS",
    "NEXUS_COMPANY_ID",
    "NEXUS_CONFIGURED_ENV_KEYS",
    "NEXUS_EXECUTION_MODE",
    "NEXUS_EXTERNAL_CHAT_EXECUTION_BOUND_KEY",
    "NEXUS_GITHUB_AUTH_MODE",
    "NEXUS_GITHUB_BRIDGE_TOKEN",
    "NEXUS_GITHUB_BROKER_TOKEN",
    "NEXUS_GITHUB_BROKER_URL",
    "NEXUS_GITHUB_HOST_HOME",
    "NEXUS_GITHUB_LAUNCHER_DIR",
    "NEXUS_GIT_METADATA_ROOTS",
    "NEXUS_GIT_TOKEN",
    "NEXUS_HARNESS_CHECKOUT_KEY",
    "NEXUS_INSTANCE_ID",
    "NEXUS_LINKED_ISSUE_IDS",
    "NEXUS_NATIVE_MCP_NAME",
    "NEXUS_NATIVE_MCP_TOKEN",
    "NEXUS_NATIVE_MCP_URL",
    "NEXUS_NATIVE_MCP_STDIO",
    "NEXUS_NATIVE_MCP_PROXY",
    "NEXUS_NORMALIZED_SESSION_ID",
    "NEXUS_PROVIDER_TRACE_MAX_BYTES",
    "NEXUS_PROVIDER_TRACE_PATH",
    "NEXUS_RUNNER_BOOTSTRAP_TICKET",
    "NEXUS_RUNNER_EXTERNAL_SANDBOX",
    "NEXUS_RUNNER_INSTANCE_ID",
    "NEXUS_RUNNER_NETWORK_ACCESS",
    "NEXUS_RUNNER_NETWORK_ROOTS",
    "NEXUS_RUNTIME_PRIMARY_URL",
    "NEXUS_RUNTIME_SERVICES_JSON",
    "NEXUS_RUNTIME_SERVICE_INTENTS_JSON",
    "NEXUS_RUN_ID",
    "NEXUS_RUNTIME_NOTIFICATION_CONTEXT",
    "NEXUS_RUNTIME_NOTIFICATION_HELPER",
    "NEXUS_TASK_ID",
    "NEXUS_WAKE_COMMENT_ID",
    "NEXUS_WAKE_PAYLOAD_JSON",
    "NEXUS_WAKE_REASON",
    "NEXUS_WORKSPACES_JSON",
    "NEXUS_WORKSPACE_AUTHORITATIVE_ROOT",
    "NEXUS_WORKSPACE_BRANCH",
    "NEXUS_WORKSPACE_CWD",
    "NEXUS_WORKSPACE_ID",
    "NEXUS_WORKSPACE_REALIZATION_MODE",
    "NEXUS_WORKSPACE_REPO_REF",
    "NEXUS_WORKSPACE_REPO_URL",
    "NEXUS_WORKSPACE_SOURCE",
    "NEXUS_WORKSPACE_WORKTREE_PATH",
    "PATH",
    "PERL5LIB",
    "PERL5OPT",
    "PYTHONHOME",
    "PYTHONPATH",
    "RUBYLIB",
    "RUBYOPT",
    "SHELL",
    "USERPROFILE",
    "XAI_API_KEY",
];

fn eligible_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        && !RESERVED.contains(&upper.as_str())
        && ![
            "LD_",
            "DYLD_",
            "GIT_CONFIG_",
            "NEXUS_RUNNER_",
            "NEXUS_NATIVE_",
            "NEXUS_GITHUB_",
            "NEXUS_ACPX_",
            "NEXUS_VERIFIED_",
        ]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
}

pub(crate) fn apply_configured_environment(
    command: &mut Command,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<(), LocalRunnerError> {
    let Some(raw) = lookup(MARKER) else {
        return Ok(());
    };
    let invalid = || LocalRunnerError::invalid("invalid configured environment projection");
    if raw.len() > 20_000 {
        return Err(invalid());
    }
    let mut names: Vec<String> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    if names.len() > 128 || names.iter().any(|name| !eligible_key(name)) {
        return Err(invalid());
    }
    names.sort();
    if names.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(invalid());
    }
    let mut bytes = 0;
    // Validate all values before modifying the child launch specification.
    let mut values = Vec::new();
    for name in &names {
        let value = lookup(name).ok_or_else(invalid)?;
        let size = name.len() + value.len();
        bytes += size;
        if value.contains('\0') || size > 65_536 || bytes > 262_144 {
            return Err(invalid());
        }
        values.push((name, value));
    }
    command.envs(values);
    command.env(
        MARKER,
        serde_json::to_string(&names).map_err(|_| invalid())?,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn rejects_reserved_malformed_missing_and_oversized_environment() {
        for raw in [
            "not-json",
            "[1]",
            "[\"NODE_OPTIONS\"]",
            "[\"BASH_ENV\"]",
            "[\"ZDOTDIR\"]",
            "[\"GH_CONFIG_DIR\"]",
            "[\"NEXUS_API_KEY\"]",
            "[\"NEXUS_RUNNER_BOOTSTRAP_TICKET\"]",
            "[\"NEXUS_RUNTIME_NOTIFICATION_CONTEXT\"]",
            "[\"NEXUS_RUNTIME_NOTIFICATION_HELPER\"]",
            "[\"OPENAI_API_KEY\"]",
            "[\"KIMI_API_KEY\"]",
            "[\"LD_PRELOAD\"]",
            "[\"bad=name\"]",
            "[\"CUSTOM\",\"CUSTOM\"]",
            "[\"MISSING\"]",
        ] {
            let mut command = Command::new("unused");
            assert!(
                apply_configured_environment(&mut command, |key| if key == MARKER {
                    Some(raw.into())
                } else {
                    None
                })
                .is_err()
            );
            assert_eq!(command.get_envs().count(), 0);
        }
        let mut command = Command::new("unused");
        assert!(apply_configured_environment(&mut command, |key| match key {
            MARKER => Some("[\"KIMI_API_KEY\"]".into()),
            "KIMI_API_KEY" => Some("selected-code-key".into()),
            _ => None,
        })
        .is_err());
        assert_eq!(command.get_envs().count(), 0);
        let mut command = Command::new("unused");
        assert!(
            apply_configured_environment(&mut command, |key| Some(if key == MARKER {
                "[\"CUSTOM\"]".into()
            } else {
                "x".repeat(65_536)
            }))
            .is_err()
        );
    }

    #[test]
    #[cfg(unix)]
    fn child_receives_only_selected_task_values_across_configuration_changes() {
        for secret in [None, Some("first-secret"), Some("rotated-secret"), None] {
            let mut source = BTreeMap::from([
                ("HOST_SECRET", "unbound-secret".to_string()),
                ("NODE_OPTIONS", "unbound-loader".to_string()),
            ]);
            let names = if let Some(value) = secret {
                source.insert("NEXUS_PAGE_AWS_SECRET_ACCESS_KEY", value.into());
                vec!["NEXUS_PAGE_AWS_SECRET_ACCESS_KEY"]
            } else {
                vec![]
            };
            source.insert(MARKER, serde_json::to_string(&names).unwrap());
            let mut command = Command::new("/bin/sh");
            command.env_clear().args(["-c", "printf '%s|%s|%s' \"$NEXUS_PAGE_AWS_SECRET_ACCESS_KEY\" \"$HOST_SECRET\" \"$NODE_OPTIONS\""]);
            apply_configured_environment(&mut command, |key| source.get(key).cloned()).unwrap();
            let output = command.output().unwrap();
            assert!(output.status.success());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("{}||", secret.unwrap_or_default())
            );
        }
    }
}
