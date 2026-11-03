// Generated from acpx-profiles.json and cursor-distributions.json. Do not edit.
pub(crate) const QUALIFIED_ACPX_VERSION: &str = "0.13.1";
pub(crate) const ACPX_DRIVER_KIND: &str = "acpx_runtime";

#[derive(Debug)]
pub(crate) struct AcpxReleaseProfile {
    pub agent_server_package: &'static str,
    pub agent_server_version: &'static str,
    pub agent_runtime_package: Option<&'static str>,
    pub agent_runtime_version: Option<&'static str>,
    pub command_digest: &'static str,
    pub requires_provider_policy: bool,
    pub qualification_pending: bool,
}

pub(crate) fn kimi_native_closure(platform: &str, architecture: &str) -> Option<&'static str> {
    match (platform, architecture) {
        ("darwin", "arm64") => {
            Some("6038325abd0431c30097ff1f572a9b29816e1b4da372d8cb86b2ca5d18ea34e7")
        }
        ("linux", "x64") => {
            Some("105d8394adbbc76a953a12cc51b5288eb940ad693291e584f6cdc6407213164d")
        }
        _ => None,
    }
}

pub(crate) fn acpx_release_profile(agent: &str) -> Option<AcpxReleaseProfile> {
    Some(match agent {
        "antigravity" => AcpxReleaseProfile {
            agent_server_package: "native:antigravity-acp",
            agent_server_version: "1.4.3",
            agent_runtime_package: Some("native:antigravity-localharness"),
            agent_runtime_version: Some("1.4.3"),
            command_digest:
                "sha256:48ca9d2fabe147d5e810e8d770bc0a961defdec984522a7a66e3ae76471155e2",
            requires_provider_policy: true,
            qualification_pending: true,
        },
        "grok" => AcpxReleaseProfile {
            agent_server_package: "builtin:grok-acp",
            agent_server_version: "1",
            agent_runtime_package: Some("native:grok"),
            agent_runtime_version: Some("1.0.13"),
            command_digest:
                "sha256:4b54075fa502cea2f410a9200c95653f2541edc665ba414cc18ee55fbacced14",
            requires_provider_policy: false,
            qualification_pending: false,
        },
        "pi" => AcpxReleaseProfile {
            agent_server_package: "pi-acp",
            agent_server_version: "0.0.33",
            agent_runtime_package: Some("@earendil-works/pi-coding-agent"),
            agent_runtime_version: Some("1.0.0"),
            command_digest:
                "sha256:5e4d305026ae51f052987b62ddd8f8adcfa461acf695a330e5f70fb510303b16",
            requires_provider_policy: true,
            qualification_pending: false,
        },
        "cursor" => AcpxReleaseProfile {
            agent_server_package: "cursor-agent",
            agent_server_version: "2026.09.26-dd393fe",
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:3af1bf37c51e2f24f27d57a4079587d9d75b634a96b08db0ca9666c1f6b03a8a",
            requires_provider_policy: true,
            qualification_pending: false,
        },
        "copilot" => AcpxReleaseProfile {
            agent_server_package: "@github/copilot",
            agent_server_version: "1.0.88",
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:7477fc258c5f1ebca55be3f2378593458c0a38e88a32cd58c012546cb0e87cd4",
            requires_provider_policy: true,
            qualification_pending: false,
        },
        "claude" => AcpxReleaseProfile {
            agent_server_package: "@agentclientprotocol/claude-agent-acp",
            agent_server_version: "0.73.0",
            agent_runtime_package: Some("@anthropic-ai/claude-agent-sdk"),
            agent_runtime_version: Some("0.3.286"),
            command_digest:
                "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
            requires_provider_policy: false,
            qualification_pending: false,
        },
        "codex" => AcpxReleaseProfile {
            agent_server_package: "@agentclientprotocol/codex-acp",
            agent_server_version: "1.6.2",
            agent_runtime_package: Some("@openai/codex"),
            agent_runtime_version: Some("0.160.0"),
            command_digest:
                "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc",
            requires_provider_policy: false,
            qualification_pending: false,
        },
        "kimi" => AcpxReleaseProfile {
            agent_server_package: "@moonshot-ai/kimi-code",
            agent_server_version: "2.3.3",
            agent_runtime_package: None,
            agent_runtime_version: None,
            command_digest:
                "sha256:284d4a42540233e0cd19d3f1739481a8da20c39eb9f19bca46e985525a095e5e",
            requires_provider_policy: true,
            qualification_pending: false,
        },
        _ => return None,
    })
}
