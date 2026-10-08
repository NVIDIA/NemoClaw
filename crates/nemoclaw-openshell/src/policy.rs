// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Input contract adapted from NVIDIA/NemoClaw at be46805b51b0d626466538e9f8fe56c8ad157549:
// schemas/network-policy.schema.json and src/lib/config/model.ts (Apache-2.0).
// 2026-09-15: represented the export fields as strict Rust types and delegated
// policy semantics to pinned openshell-policy.
// 2026-09-28: use owner policy types independently of the transport client.
//! Credential-free sandbox policies: the authored model, its schema
//! constraints, and conversion to and from OpenShell's protocol.

use nemoclaw_backend::{ConfigError, ObservationError};
use openshell_sdk::raw::proto;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::LazyLock};

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
    /// Omit for automatic TLS handling, or use skip for a raw tunnel.
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

/// Application protocols a policy endpoint may restrict.
pub const POLICY_PROTOCOLS: &[&str] = &["rest", "websocket", "json-rpc", "mcp"];
/// TLS handling a policy endpoint may select.
pub const POLICY_TLS: &[&str] = &["skip"];
/// Enforcement modes a policy endpoint may select.
pub const POLICY_ENFORCEMENT: &[&str] = &["enforce", "audit"];
/// Access presets a policy endpoint may select.
pub const POLICY_ACCESS: &[&str] = &["full", "read-only"];
/// Largest request body a policy may buffer for inspection.
pub const POLICY_BODY_MAX: u32 = 1_048_576;

fn property(schema: &mut Value, field: &str, extra: Value) {
    let Value::Object(extra) = extra else {
        panic!("property constraints must be objects");
    };
    schema["properties"][field]
        .as_object_mut()
        .expect("derived field exists")
        .extend(extra);
}

/// Add the value constraints that the policy types cannot express to their
/// schema definitions in `defs`.
pub fn constrain(defs: &mut serde_json::Map<String, Value>) {
    property(&mut defs["ExplicitPolicy"], "version", json!({"const": 1}));
    property(
        &mut defs["PolicyLandlock"],
        "compatibility",
        json!({"enum": ["best_effort", "hard_requirement"]}),
    );
    for (field, choices) in [
        ("protocol", json!(POLICY_PROTOCOLS)),
        ("tls", json!(POLICY_TLS)),
        ("enforcement", json!(POLICY_ENFORCEMENT)),
        ("access", json!(POLICY_ACCESS)),
    ] {
        property(&mut defs["PolicyEndpoint"], field, json!({"enum": choices}));
    }
    property(&mut defs["PolicyEndpoint"], "port", json!({"minimum": 1}));
    property(
        &mut defs["PolicyEndpoint"],
        "ports",
        json!({"minItems": 1, "uniqueItems": true, "items": {"type": "integer", "minimum": 1, "maximum": 65535}}),
    );
    defs["PolicyEndpoint"]["allOf"] = json!([
        {"oneOf": [{"required": ["port"], "not": {"required": ["ports"]}}, {"required": ["ports"], "not": {"required": ["port"]}}]},
        {"anyOf": [{"required": ["host"], "properties":{"host":{"minLength":1}}}, {"required": ["allowed_ips"], "properties":{"allowed_ips":{"minItems":1}}}]},
        {"not": {"required": ["access", "rules"]}}
    ]);
    for field in ["rules", "deny_rules"] {
        property(&mut defs["PolicyEndpoint"], field, json!({"minItems": 1}));
    }
    for name in ["PolicyJsonRpc", "PolicyMcp"] {
        property(
            &mut defs[name],
            "max_body_bytes",
            json!({"minimum": 1, "maximum": POLICY_BODY_MAX}),
        );
    }
}

/// Constrained schema definitions of the policy types, keyed by type name.
pub fn definitions() -> serde_json::Map<String, Value> {
    let mut generator = schemars::generate::SchemaSettings::draft2020_12().into_generator();
    generator.subschema_for::<ExplicitPolicy>();
    let mut defs = generator.take_definitions(true);
    constrain(&mut defs);
    defs
}

static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::validator_for(&json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$defs": definitions(),
        "$ref": "#/$defs/ExplicitPolicy",
    }))
    .expect("sandbox policy schema must compile")
});

impl ExplicitPolicy {
    pub fn to_proto(&self) -> Result<proto::SandboxPolicy, ConfigError> {
        let input = serde_json::to_value(self)
            .map_err(|_| ConfigError::new("cannot encode sandbox policy"))?;
        VALIDATOR
            .validate(&input)
            .map_err(|_| ConfigError::new("invalid or unsupported explicit sandbox policy"))?;
        let policy = openshell_policy::parse_sandbox_policy(&input.to_string())
            .map_err(|_| ConfigError::new("invalid or unsupported explicit sandbox policy"))?;
        openshell_policy::validate_sandbox_policy(&policy)
            .map_err(|_| ConfigError::new("explicit sandbox policy failed OpenShell validation"))?;
        Ok(policy)
    }
}

fn canonical(policy: &proto::SandboxPolicy) -> Result<String, ObservationError> {
    let mut policy = policy.clone();
    if let Some(fs) = &mut policy.filesystem {
        fs.read_only.sort();
        fs.read_write.sort();
    }
    let mut value = openshell_policy::sandbox_policy_to_json_value(&policy)
        .map_err(|_| ObservationError::Incomplete)?;
    value
        .as_object_mut()
        .ok_or(ObservationError::Incomplete)?
        .entry("network_policies")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(rules) = value["network_policies"].as_object_mut() {
        for rule in rules.values_mut() {
            let rule = rule.as_object_mut().ok_or(ObservationError::Incomplete)?;
            rule.entry("binaries")
                .or_insert_with(|| serde_json::json!([]));
            rule.entry("endpoints")
                .or_insert_with(|| serde_json::json!([]));
        }
    }
    // Refuse fields the SDK cannot retain, including credential bindings and middleware.
    let typed: ExplicitPolicy =
        serde_json::from_value(value.clone()).map_err(|_| ObservationError::Incomplete)?;
    let decoded = typed.to_proto().map_err(|_| ObservationError::Incomplete)?;
    if decoded != policy {
        return Err(ObservationError::Incomplete);
    }
    value.sort_all_objects();
    Ok(value.to_string())
}
pub fn policy_json(policy: &proto::SandboxPolicy) -> Result<String, ObservationError> {
    canonical(policy)
}
