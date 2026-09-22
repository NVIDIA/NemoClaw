// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::HarnessKind;
// Input contract adapted from NVIDIA/NemoClaw at be46805b51b0d626466538e9f8fe56c8ad157549:
// schemas/network-policy.schema.json and src/lib/config/model.ts (Apache-2.0).
// 2026-09-15: represented the export fields as strict Rust types, added explicit
// preset selection, and delegated policy semantics to pinned openshell-policy.
// 2026-09-19: removed the main-branch Landlock spelling translation and the
// redundant external-proxy ownership annotation.
// 2026-09-21: made policy selection exclusive in Rust while preserving the input shape.
use super::ConfigError;
use openshell_core::proto;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Sandbox policy selection and optional agent HTTP proxy.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "NetworkInput", into = "NetworkInput")]
#[schemars(with = "NetworkInput")]
pub struct Network {
    /// Isolated preset or a complete authored policy; the two cannot coexist.
    pub policy: NetworkPolicy,
    /// Existing HTTP proxy used by the agent, independent of policy selection.
    pub proxy: Option<Proxy>,
}

/// Sandbox policy source. Explicit policies replace the isolated preset completely.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum NetworkPolicy {
    /// SDK-provided isolated policy.
    #[default]
    Isolated,
    /// Complete authored OpenShell policy; no isolated defaults are merged.
    Explicit(ExplicitPolicy),
}

// Keep the authored YAML shape at the serialization boundary. Runtime code
// receives one policy choice, never independently mutable tier and policy fields.
#[derive(Default, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default, rename = "Network")]
#[serde(default, deny_unknown_fields)]
/// Sandbox policy selection and optional agent HTTP proxy.
struct NetworkInput {
    #[serde(rename = "tier")]
    #[schemars(default)]
    /// Isolated policy preset. Omit when declaring policy.explicit; omission without policy selects isolated.
    #[serde(skip_serializing_if = "String::is_empty")]
    tier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ExplicitPolicySelection")]
    /// Complete authored OpenShell policy, replacing the isolated preset.
    policy: Option<ExplicitPolicySelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Proxy")]
    /// HTTP proxy address used by the agent process. Does not create a proxy or change gateway networking.
    proxy: Option<Proxy>,
}

impl TryFrom<NetworkInput> for Network {
    type Error = ConfigError;

    fn try_from(input: NetworkInput) -> Result<Self, Self::Error> {
        let policy = match (input.tier.as_str(), input.policy) {
            ("", Some(policy)) => NetworkPolicy::Explicit(policy.explicit),
            ("" | super::constraints::NETWORK_TIER, None) => NetworkPolicy::Isolated,
            _ => {
                return Err(ConfigError::new(
                    "choose either isolated tier or an explicit policy",
                ));
            }
        };
        Ok(Self {
            policy,
            proxy: input.proxy,
        })
    }
}

impl From<Network> for NetworkInput {
    fn from(network: Network) -> Self {
        let (tier, policy) = match network.policy {
            NetworkPolicy::Isolated => (super::constraints::NETWORK_TIER.into(), None),
            NetworkPolicy::Explicit(explicit) => {
                (String::new(), Some(ExplicitPolicySelection { explicit }))
            }
        };
        Self {
            tier,
            policy,
            proxy: network.proxy,
        }
    }
}

/// Select an explicit policy; no isolated defaults are merged into it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExplicitPolicySelection {
    /// Complete sandbox policy in OpenShell YAML field names.
    explicit: ExplicitPolicy,
}

/// Existing agent HTTP proxy, reachable from inside the sandbox. NemoClaw does not manage it. Credentials and URL syntax are excluded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Proxy {
    /// Proxy hostname or IPv4 address, without scheme, path, or credentials.
    pub host: String,
    /// Proxy TCP port, from 1 through 65535.
    pub port: u16,
}

/// Credential-free OpenShell policy. Validation and protocol conversion use the pinned OpenShell policy library.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExplicitPolicy {
    /// Policy format version; currently 1.
    pub version: u32,
    /// Filesystem grants. Omission retains OpenShell filesystem defaults, not the isolated preset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyFilesystem")]
    pub filesystem_policy: Option<PolicyFilesystem>,
    /// Kernel filesystem enforcement compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyLandlock")]
    pub landlock: Option<PolicyLandlock>,
    /// Sandbox process user and group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyProcess")]
    pub process: Option<PolicyProcess>,
    /// Named egress rules. An empty map grants no general egress.
    pub network_policies: BTreeMap<String, PolicyRule>,
}

/// Filesystem access grants inside the sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyFilesystem {
    /// Whether to include the working directory as writable; omitted means false in a declared filesystem policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub include_workdir: Option<bool>,
    /// Absolute read-only paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Vec<String>")]
    pub read_only: Option<Vec<String>>,
    /// Absolute writable paths.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Vec<String>")]
    pub read_write: Option<Vec<String>>,
}

/// Landlock compatibility; hard_requirement refuses unavailable enforcement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyLandlock {
    /// best_effort or hard_requirement.
    pub compatibility: String,
}

/// Process identity resolved inside the sandbox image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyProcess {
    /// sandbox or a numeric non-root sandbox UID accepted by OpenShell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub run_as_user: Option<String>,
    /// sandbox or a numeric non-root sandbox GID accepted by OpenShell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub run_as_group: Option<String>,
}

/// Named endpoint grants restricted to declared executable paths.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyRule {
    /// Human-readable rule name.
    pub name: String,
    /// Allowed destinations and optional application-protocol restrictions.
    pub endpoints: Vec<PolicyEndpoint>,
    /// Executable identities allowed to use these destinations.
    pub binaries: Vec<PolicyBinary>,
}

/// Executable identity for an egress grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyBinary {
    /// Absolute executable path inside the sandbox.
    pub path: String,
}

/// TCP destination and optional application-protocol policy. Invalid or conflicting combinations are rejected by OpenShell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyEndpoint {
    /// Destination hostname or DNS glob; may be omitted with allowed_ips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub host: Option<String>,
    /// Single TCP port; mutually exclusive with ports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u16")]
    pub port: Option<u16>,
    /// Nonempty unique TCP ports; mutually exclusive with port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Vec<u16>")]
    pub ports: Option<Vec<u16>>,
    /// HTTP path glob selecting the endpoint on a shared host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub path: Option<String>,
    /// rest, websocket, json-rpc, or mcp; omit for TCP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub protocol: Option<String>,
    /// terminate, passthrough, or skip, subject to protocol validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub tls: Option<String>,
    /// enforce or audit; omission follows OpenShell defaults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub enforcement: Option<String>,
    /// full or read-only preset; mutually exclusive with rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub access: Option<String>,
    /// Resolved IP addresses or CIDRs allowed by OpenShell destination validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Vec<String>")]
    pub allowed_ips: Option<Vec<String>>,
    /// Application-protocol allow rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Vec<PolicyAllowRule>")]
    pub rules: Option<Vec<PolicyAllowRule>>,
    /// Application-protocol deny rules, evaluated before allow rules.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Vec<PolicyMatcher>")]
    pub deny_rules: Option<Vec<PolicyMatcher>>,
    /// Allow encoded slash path segments when required by the upstream API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub allow_encoded_slash: Option<bool>,
    /// Enable OpenShell placeholder rewriting after an allowed REST WebSocket upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub websocket_credential_rewrite: Option<bool>,
    /// Enable OpenShell placeholder rewriting in supported REST request bodies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub request_body_credential_rewrite: Option<bool>,
    /// JSON-RPC inspection limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyJsonRpc")]
    pub json_rpc: Option<PolicyJsonRpc>,
    /// MCP method and tool inspection settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyMcp")]
    pub mcp: Option<PolicyMcp>,
}

/// One allowed application-protocol action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyAllowRule {
    /// Request matcher.
    pub allow: PolicyMatcher,
}

/// Request method/path or MCP tool selector; protocol-specific combinations are validated by OpenShell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyMatcher {
    /// HTTP or RPC method.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub method: Option<String>,
    /// HTTP path glob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "String")]
    pub path: Option<String>,
    /// MCP tool-name selector.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "PolicyValueMatcher")]
    pub tool: Option<PolicyValueMatcher>,
    /// MCP parameters; only name is supported by the pinned protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "BTreeMap<String, PolicyValueMatcher>")]
    pub params: Option<BTreeMap<String, PolicyValueMatcher>>,
}

/// A literal glob or a nonempty list of alternative globs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
pub enum PolicyValueMatcher {
    /// A single glob.
    Glob(String),
    /// Alternative globs.
    Any(PolicyAnyMatcher),
}

/// Alternative values for a policy matcher.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyAnyMatcher {
    /// Nonempty list of nonempty glob strings.
    pub any: Vec<String>,
}

/// JSON-RPC request inspection bounds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyJsonRpc {
    /// Maximum buffered request bytes, 1 through 1048576.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32")]
    pub max_body_bytes: Option<u32>,
}

/// MCP request inspection and tool-name restrictions.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PolicyMcp {
    /// Supported MCP protocol revisions; omission uses the pinned OpenShell default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Vec<String>")]
    pub versions: Option<Vec<String>>,
    /// Maximum buffered request bytes, 1 through 1048576.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32")]
    pub max_body_bytes: Option<u32>,
    /// Enforce standard MCP tool-name syntax; defaults to true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub strict_tool_names: Option<bool>,
    /// Allow known MCP methods, subject to tool restrictions; defaults to false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub allow_all_known_mcp_methods: Option<bool>,
}

impl Proxy {
    pub fn validate(&self) -> Result<(), ConfigError> {
        super::schema::validate_definition("Proxy", self)
    }
}
impl Network {
    pub(crate) fn validate_runtime_access(&self, harness: HarnessKind) -> Result<(), ConfigError> {
        let NetworkPolicy::Explicit(policy) = &self.policy else {
            return Ok(());
        };
        let Some(filesystem) = &policy.filesystem_policy else {
            return Ok(());
        };
        for (required, diagnostic) in crate::openshell::runtime_read_requirements(harness) {
            let covered = filesystem
                .read_only
                .iter()
                .flatten()
                .chain(filesystem.read_write.iter().flatten())
                .any(|grant| {
                    // Sandbox paths are POSIX paths even on a Windows client. Do not
                    // resolve symlinks against the client filesystem or infer '..'.
                    if !grant.starts_with('/') || grant.split('/').any(|part| part == "..") {
                        return false;
                    }
                    let mut required = required.split('/').filter(|part| !part.is_empty());
                    grant
                        .split('/')
                        .filter(|part| !part.is_empty() && *part != ".")
                        .all(|part| required.next() == Some(part))
                });
            if !covered {
                return Err(ConfigError::new(diagnostic));
            }
        }
        Ok(())
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        super::schema::validate_definition("Network", self)?;
        if let NetworkPolicy::Explicit(policy) = &self.policy {
            policy.to_proto()?;
        }
        Ok(())
    }
    pub fn policy_proto(&self) -> Result<proto::SandboxPolicy, ConfigError> {
        match &self.policy {
            NetworkPolicy::Isolated => Ok(crate::openshell::policy()),
            NetworkPolicy::Explicit(policy) => policy.to_proto(),
        }
    }
}
pub(crate) const POLICY_PROTOCOLS: &[&str] = &["rest", "websocket", "json-rpc", "mcp"];
pub(crate) const POLICY_TLS: &[&str] = &["terminate", "passthrough", "skip"];
pub(crate) const POLICY_ENFORCEMENT: &[&str] = &["enforce", "audit"];
pub(crate) const POLICY_ACCESS: &[&str] = &["full", "read-only"];
pub(crate) const POLICY_BODY_MAX: u32 = 1_048_576;
impl ExplicitPolicy {
    pub fn to_proto(&self) -> Result<proto::SandboxPolicy, ConfigError> {
        super::schema::validate_definition("ExplicitPolicy", self)?;
        let input = serde_json::to_value(self)
            .map_err(|_| ConfigError::new("cannot encode sandbox policy"))?;
        let policy = openshell_policy::parse_sandbox_policy(&input.to_string())
            .map_err(|_| ConfigError::new("invalid or unsupported explicit sandbox policy"))?;
        openshell_policy::validate_sandbox_policy(&policy)
            .map_err(|_| ConfigError::new("explicit sandbox policy failed OpenShell validation"))?;
        Ok(policy)
    }
}
