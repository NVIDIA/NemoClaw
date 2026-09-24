// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Interpret advertised Fabric metadata without treating absent claims as support.
//! Tool support here means descriptor-advertised tool configuration, not proof
//! that an inference model can execute tool calls.
use crate::fabric_catalog::{FabricAdapter, FabricCatalog};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AdapterCapabilities {
    pub adapter_id: String,
    pub harness: String,
    pub apis: Option<Vec<String>>,
    pub streaming: Support,
    pub service: Support,
    pub cancellation: Support,
    pub updates: Support,
    pub tools: Support,
    pub interfaces: Option<Vec<String>>,
    pub interfaces_complete: bool,
    pub config_fields: Option<Vec<String>>,
    pub settings_schema: Option<Value>,
    pub model_schema: Option<Value>,
    pub requirements: Option<Value>,
    pub required_binaries: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FabricRequirements {
    pub harness: String,
    pub api: Option<String>,
    #[serde(default)]
    pub additional_apis: Vec<String>,
    pub streaming: bool,
    pub tools: bool,
    pub interfaces: Vec<String>,
    pub config_fields: Vec<String>,
}

impl FabricRequirements {
    pub fn for_sandbox(
        document: &crate::config::Document,
        sandbox: &crate::config::Sandbox,
    ) -> Result<Self, crate::config::ConfigError> {
        use crate::config::{AgentInterfaces, HermesDashboard};
        let harness = document.sandbox_harness(sandbox)?;
        let settings = document.sandbox_runtime_settings(sandbox)?;
        let mut apis = vec![api_name(settings.api).to_owned()];
        for agent in &settings.agents {
            if let Some(inference) = &agent.inference {
                for model in inference.models.values() {
                    let api = api_name(model.api).to_owned();
                    if !apis.contains(&api) {
                        apis.push(api);
                    }
                }
            }
        }
        let interfaces = match harness.interfaces.as_ref() {
            Some(AgentInterfaces::OpenClaw(_)) => vec!["dashboard".into()],
            Some(AgentInterfaces::Hermes(interfaces)) => {
                let mut names = vec!["api".into()];
                if !matches!(interfaces.dashboard, Some(HermesDashboard::Disabled)) {
                    names.push("dashboard".into());
                }
                names
            }
            None => vec![],
        };
        Ok(Self {
            harness: harness.kind.as_str().into(),
            api: Some(apis.remove(0)),
            additional_apis: apis,
            tools: sandbox.agent.tools.is_some(),
            interfaces,
            ..Self::default()
        })
    }
}

pub fn api_name(api: crate::config::InferenceApi) -> &'static str {
    use crate::config::InferenceApi;
    match api {
        InferenceApi::OpenaiCompletions => "openai-completions",
        InferenceApi::OpenaiResponses => "openai-responses",
        InferenceApi::AnthropicMessages => "anthropic-messages",
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityCheck {
    pub requirement: String,
    pub status: Support,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompatibilityReport {
    pub status: Support,
    pub adapter_id: Option<String>,
    pub checks: Vec<CapabilityCheck>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageMetadata {
    pub architecture: Option<String>,
    pub operating_system: Option<String>,
    pub repo_digests: Vec<String>,
    pub size_bytes: Option<i64>,
}

fn strings(value: Option<&Value>) -> Option<Vec<String>> {
    value?
        .as_array()?
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect()
}
fn boolean(value: Option<&Value>) -> Support {
    match value.and_then(Value::as_bool) {
        Some(true) => Support::Supported,
        Some(false) => Support::Unsupported,
        None => Support::Unknown,
    }
}

/// Project explicit fields from the canonical descriptor. Unknown fields stay
/// available in the original descriptor and schemas, without guessed defaults.
pub fn project_adapter(adapter: &FabricAdapter) -> AdapterCapabilities {
    let descriptor = &adapter.descriptor;
    let settings_schema = descriptor.get("settings_schema");
    let apis = settings_schema
        .and_then(|schema| {
            [
                "/properties/inference/properties/api",
                "/properties/api_type",
                "/properties/api_mode",
            ]
            .into_iter()
            .find_map(|path| {
                let field = schema.pointer(path)?;
                let field = match field.get("$ref").and_then(Value::as_str) {
                    Some(reference) => schema.pointer(reference.strip_prefix('#')?)?,
                    None => field,
                };
                strings(field.get("enum"))
            })
        })
        .map(|values| {
            values
                .into_iter()
                .map(|value| match value.as_str() {
                    "chat_completions" => "openai-completions".into(),
                    "codex_responses" => "openai-responses".into(),
                    "anthropic_messages" => "anthropic-messages".into(),
                    _ => value,
                })
                .collect()
        });
    let config_fields = strings(descriptor.pointer("/config/accepts"));
    let tools = if descriptor.get("tool_definition_schema").is_some()
        || config_fields
            .as_ref()
            .is_some_and(|fields| fields.iter().any(|field| field.starts_with("tools.")))
        || descriptor
            .pointer(
                "/settings_schema/properties/inference/properties/agents/items/properties/tools",
            )
            .is_some()
    {
        Support::Supported
    } else {
        Support::Unknown
    };
    let interfaces = descriptor
        .pointer("/settings_schema/properties/inference/properties/interfaces/properties")
        .and_then(Value::as_object)
        .map(|properties| properties.keys().cloned().collect());
    AdapterCapabilities {
        adapter_id: adapter.adapter_id.clone(),
        harness: adapter.harness.clone(),
        apis,
        streaming: boolean(descriptor.pointer("/capabilities/streaming")),
        service: boolean(descriptor.pointer("/capabilities/service")),
        cancellation: boolean(descriptor.pointer("/capabilities/cancellation")),
        updates: boolean(descriptor.pointer("/capabilities/updates")),
        tools,
        interfaces,
        interfaces_complete: descriptor
            .pointer(
                "/settings_schema/properties/inference/properties/interfaces/additionalProperties",
            )
            .and_then(Value::as_bool)
            == Some(false),
        config_fields,
        settings_schema: descriptor.get("settings_schema").cloned(),
        model_schema: descriptor.get("model_schema").cloned(),
        requirements: descriptor.get("requirements").cloned(),
        required_binaries: strings(descriptor.pointer("/requirements/binaries")),
    }
}

fn check(requirement: impl Into<String>, status: Support) -> CapabilityCheck {
    CapabilityCheck {
        requirement: requirement.into(),
        status,
        reason: match status {
            Support::Supported => "advertised metadata satisfies the requirement",
            Support::Unsupported => "advertised metadata excludes the requirement",
            Support::Unknown => "metadata does not establish this capability",
        }
        .into(),
    }
}
fn membership(values: Option<&Vec<String>>, value: &str) -> Support {
    match values {
        Some(values) if values.iter().any(|item| item == value) => Support::Supported,
        Some(_) => Support::Unsupported,
        None => Support::Unknown,
    }
}
fn overall(checks: &[CapabilityCheck]) -> Support {
    if checks
        .iter()
        .any(|check| check.status == Support::Unsupported)
    {
        Support::Unsupported
    } else if checks.iter().any(|check| check.status == Support::Unknown) {
        Support::Unknown
    } else {
        Support::Supported
    }
}

/// Require one adapter to satisfy the complete request. Capabilities from
/// different adapters are never combined into a fictitious supported adapter.
pub fn assess_fabric(catalog: &FabricCatalog, request: &FabricRequirements) -> CompatibilityReport {
    let mut best = CompatibilityReport {
        status: Support::Unsupported,
        adapter_id: None,
        checks: vec![check(
            format!("harness:{}", request.harness),
            Support::Unsupported,
        )],
    };
    for adapter in catalog
        .adapters
        .iter()
        .filter(|adapter| adapter.harness == request.harness)
    {
        let projected = project_adapter(adapter);
        let mut checks = vec![check(
            format!("harness:{}", request.harness),
            Support::Supported,
        )];
        for api in request.api.iter().chain(&request.additional_apis) {
            checks.push(check(
                format!("api:{api}"),
                membership(projected.apis.as_ref(), api),
            ));
        }
        if request.streaming {
            checks.push(check("streaming", projected.streaming));
        }
        if request.tools {
            checks.push(check("tools", projected.tools));
        }
        for interface in &request.interfaces {
            checks.push(check(
                format!("interface:{interface}"),
                match membership(projected.interfaces.as_ref(), interface) {
                    Support::Unsupported if !projected.interfaces_complete => Support::Unknown,
                    status => status,
                },
            ));
        }
        for field in &request.config_fields {
            checks.push(check(
                format!("config:{field}"),
                membership(projected.config_fields.as_ref(), field),
            ));
        }
        let report = CompatibilityReport {
            status: overall(&checks),
            adapter_id: Some(adapter.adapter_id.clone()),
            checks,
        };
        if report.status == Support::Supported {
            return report;
        }
        if best.adapter_id.is_none()
            || (report.status == Support::Unknown && best.status == Support::Unsupported)
        {
            best = report;
        }
    }
    best
}

fn architecture(value: &str) -> &str {
    match value {
        "x86_64" | "x86-64" => "amd64",
        "aarch64" => "arm64",
        _ => value,
    }
}

/// Compare the inspected image to the execution engine. Missing metadata is
/// unknown; a matching CPU architecture does not prove GPU or model feasibility.
pub fn assess_image_platform(
    image: &ImageMetadata,
    engine_architecture: Option<&str>,
    engine_os: Option<&str>,
) -> CompatibilityReport {
    let compare = |left: Option<&str>, right: Option<&str>| match (left, right) {
        (Some(left), Some(right)) if !left.is_empty() && !right.is_empty() => {
            if left == right {
                Support::Supported
            } else {
                Support::Unsupported
            }
        }
        _ => Support::Unknown,
    };
    let checks = vec![
        check(
            "image_architecture",
            compare(
                image.architecture.as_deref().map(architecture),
                engine_architecture.map(architecture),
            ),
        ),
        check(
            "image_operating_system",
            compare(image.operating_system.as_deref(), engine_os),
        ),
    ];
    CompatibilityReport {
        status: overall(&checks),
        adapter_id: None,
        checks,
    }
}

/// Compare manifest digests, never the container configuration ID. Registry
/// aliases may differ while referring to the same immutable manifest.
pub fn assess_image_digest(image: &ImageMetadata, reference: &str) -> CompatibilityReport {
    let valid_digest = |value: &str| {
        value.strip_prefix("sha256:").is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    };
    let expected = reference
        .rsplit_once('@')
        .map(|(_, digest)| digest)
        .filter(|digest| valid_digest(digest));
    let digests: Vec<_> = image
        .repo_digests
        .iter()
        .filter_map(|reference| reference.rsplit_once('@').map(|(_, digest)| digest))
        .filter(|digest| valid_digest(digest))
        .collect();
    let status = match expected {
        Some(expected) if digests.contains(&expected) => Support::Supported,
        Some(_) if !digests.is_empty() => Support::Unsupported,
        _ => Support::Unknown,
    };
    CompatibilityReport {
        status,
        adapter_id: None,
        checks: vec![check("image_digest", status)],
    }
}

/// Evaluate adapter requirements and image metadata through one shared rule set.
/// Platform checking is requested only when the caller supplies either engine
/// platform field; legacy metadata-only callers do not acquire new prerequisites.
pub fn assess_image(
    catalog: Option<&FabricCatalog>,
    request: &FabricRequirements,
    image: &ImageMetadata,
    reference: &str,
    engine_architecture: Option<&str>,
    engine_os: Option<&str>,
) -> CompatibilityReport {
    let mut report = match catalog {
        Some(catalog) => assess_fabric(catalog, request),
        None => CompatibilityReport {
            status: Support::Unknown,
            adapter_id: None,
            checks: vec![check("fabric_catalog", Support::Unknown)],
        },
    };
    report
        .checks
        .extend(assess_image_digest(image, reference).checks);
    if engine_architecture.is_some() || engine_os.is_some() {
        report
            .checks
            .extend(assess_image_platform(image, engine_architecture, engine_os).checks);
    }
    report.status = overall(&report.checks);
    report
}
