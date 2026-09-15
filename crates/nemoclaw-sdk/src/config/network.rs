// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Input contract adapted from NVIDIA/NemoClaw at be46805b51b0d626466538e9f8fe56c8ad157549:
// schemas/network-policy.schema.json and src/lib/config/model.ts (Apache-2.0).
// 2026-09-15: represented the export fields as strict Rust types, added explicit
// preset selection, and delegated policy semantics to pinned openshell-policy.
use super::{ConfigError, Network};
use openshell_core::proto;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Select an explicit policy; no isolated defaults are merged into it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExplicitPolicySelection {
    /// Complete sandbox policy in OpenShell YAML field names.
    pub explicit: ExplicitPolicy,
}

/// Agent HTTP proxy, reachable from inside the sandbox. Credentials and URL syntax are excluded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Proxy {
    /// Optional external ownership declaration. Omission means external; NemoClaw does not create this proxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "super::ExternalManagement")]
    pub management: Option<super::ExternalManagement>,
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
    /// best_effort or hard_requirement. The main-branch spelling strict maps to hard_requirement.
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
        if self.port == 0
            || self.host.is_empty()
            || self.host.len() > 256
            || !self
                .host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(ConfigError(
                "proxy requires a hostname or IPv4 address and a port from 1 through 65535",
            ));
        }
        Ok(())
    }
}
impl Network {
    pub fn validate(&self) -> Result<(), ConfigError> {
        match &self.policy {
            Some(policy) if self.tier.is_empty() => {
                policy.explicit.to_proto()?;
            }
            None if self.tier == super::constraints::NETWORK_TIER => {}
            _ => {
                return Err(ConfigError(
                    "choose either isolated tier or an explicit policy",
                ));
            }
        }
        if let Some(proxy) = &self.proxy {
            proxy.validate()?;
        }
        Ok(())
    }
    pub fn policy_proto(&self) -> Result<proto::SandboxPolicy, ConfigError> {
        self.policy
            .as_ref()
            .map_or_else(|| Ok(crate::openshell::policy()), |p| p.explicit.to_proto())
    }
}
pub(crate) const POLICY_PROTOCOLS: &[&str] = &["rest", "websocket", "json-rpc", "mcp"];
pub(crate) const POLICY_TLS: &[&str] = &["terminate", "passthrough", "skip"];
pub(crate) const POLICY_ENFORCEMENT: &[&str] = &["enforce", "audit"];
pub(crate) const POLICY_ACCESS: &[&str] = &["full", "read-only"];
pub(crate) const POLICY_BODY_MAX: u32 = 1_048_576;
impl PolicyEndpoint {
    fn validate(&self) -> Result<(), ConfigError> {
        let invalid = self.port.is_some() == self.ports.is_some()
            || self.port == Some(0)
            || self.ports.as_ref().is_some_and(|p| {
                p.is_empty()
                    || p.contains(&0)
                    || p.iter().collect::<std::collections::BTreeSet<_>>().len() != p.len()
            })
            || (self.host.as_ref().is_none_or(String::is_empty)
                && self.allowed_ips.as_ref().is_none_or(Vec::is_empty))
            || self.rules.as_ref().is_some_and(Vec::is_empty)
            || self.deny_rules.as_ref().is_some_and(Vec::is_empty)
            || (self.access.is_some() && self.rules.is_some())
            || self
                .json_rpc
                .as_ref()
                .and_then(|r| r.max_body_bytes)
                .is_some_and(|v| v == 0 || v > POLICY_BODY_MAX)
            || self
                .mcp
                .as_ref()
                .and_then(|r| r.max_body_bytes)
                .is_some_and(|v| v == 0 || v > POLICY_BODY_MAX);
        if invalid
            || [
                (&self.protocol, POLICY_PROTOCOLS),
                (&self.tls, POLICY_TLS),
                (&self.enforcement, POLICY_ENFORCEMENT),
                (&self.access, POLICY_ACCESS),
            ]
            .iter()
            .any(|(value, choices)| {
                value
                    .as_ref()
                    .is_some_and(|v| !choices.contains(&v.as_str()))
            })
        {
            return Err(ConfigError(
                "invalid or conflicting policy endpoint options",
            ));
        }
        Ok(())
    }
}
impl ExplicitPolicy {
    pub fn to_proto(&self) -> Result<proto::SandboxPolicy, ConfigError> {
        if self.version != 1 {
            return Err(ConfigError("explicit policy requires version 1"));
        }
        for rule in self.network_policies.values() {
            for endpoint in &rule.endpoints {
                endpoint.validate()?;
            }
        }
        let mut input =
            serde_json::to_value(self).map_err(|_| ConfigError("cannot encode sandbox policy"))?;
        // Main's exported schema spells strict enforcement differently from the pinned runtime.
        if input
            .pointer("/landlock/compatibility")
            .and_then(|v| v.as_str())
            == Some("strict")
        {
            input["landlock"]["compatibility"] = serde_json::json!("hard_requirement");
        }
        if self.landlock.as_ref().is_some_and(|l| {
            !["strict", "best_effort", "hard_requirement"].contains(&l.compatibility.as_str())
        }) {
            return Err(ConfigError("unsupported Landlock compatibility"));
        }
        let policy = openshell_policy::parse_sandbox_policy(&input.to_string())
            .map_err(|_| ConfigError("invalid or unsupported explicit sandbox policy"))?;
        openshell_policy::validate_sandbox_policy(&policy)
            .map_err(|_| ConfigError("explicit sandbox policy failed OpenShell validation"))?;
        Ok(policy)
    }
}
