// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Interpret advertised Fabric metadata without treating absent claims as support.
//! Tool support here means descriptor-advertised tool configuration, not proof
//! that an inference model can execute tool calls.
use crate::fabric_catalog::FabricCatalog;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FabricRequirements {
    pub configuration: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem_read: Option<Vec<String>>,
}

impl FabricRequirements {
    pub fn for_sandbox(
        document: &crate::config::Document,
        sandbox: &crate::config::Sandbox,
    ) -> Result<Self, crate::config::ConfigError> {
        let filesystem_read = match &sandbox.network.policy {
            crate::config::NetworkPolicy::Explicit(policy) => {
                policy.filesystem_policy.as_ref().map(|fs| {
                    fs.read_only
                        .iter()
                        .flatten()
                        .chain(fs.read_write.iter().flatten())
                        .cloned()
                        .collect()
                })
            }
            _ => None,
        };
        Ok(Self {
            configuration: crate::fabric_config::for_sandbox(document, sandbox)?,
            filesystem_read,
        })
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

struct OfflineSchemas;
impl jsonschema::Retrieve for OfflineSchemas {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(format!("external schema retrieval is disabled: {uri}").into())
    }
}

/// Validate an instance against advertised metadata without network or file
/// retrieval. Invalid or unresolved schemas provide no evidence of support.
pub fn schema_accepts(schema: &Value, value: &Value) -> Option<bool> {
    jsonschema::options()
        .with_retriever(OfflineSchemas)
        .build(schema)
        .ok()
        .map(|validator| validator.is_valid(value))
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
    let configuration = request.configuration.clone();
    let result = plan_configuration(catalog, configuration);
    let status = match &result {
        Ok(_) => Support::Supported,
        Err(FabricPlanningError::Unverified) => Support::Unknown,
        Err(FabricPlanningError::Rejected) => Support::Unsupported,
    };
    let mut checks = vec![CapabilityCheck {
        requirement: "fabric_plan".into(),
        status,
        reason: match status {
            Support::Supported => {
                "Fabric accepted the configuration against the selected descriptor snapshot"
            }
            Support::Unsupported => {
                "Fabric rejected the configuration against the selected descriptor snapshot"
            }
            Support::Unknown => {
                "The selected image does not establish compatibility with the SDK Fabric contract"
            }
        }
        .into(),
    }];
    if let (Ok(plan), Some(grants)) = (&result, &request.filesystem_read)
        && let Some(descriptor) = &plan.adapter_descriptor
    {
        for file in &descriptor.descriptor.requirements.files {
            let allowed = file.is_absolute() && grants.iter().any(|grant| file.starts_with(grant));
            checks.push(check(
                "deployment_filesystem_grant",
                if allowed {
                    Support::Supported
                } else {
                    Support::Unsupported
                },
            ));
        }
    }
    CompatibilityReport {
        status: overall(&checks),
        adapter_id: request
            .configuration
            .pointer("/harness/adapter_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        checks,
    }
}

/// Secret-safe classification of canonical planning results.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum FabricPlanningError {
    #[error("Fabric compatibility cannot be established for the selected image contract")]
    Unverified,
    #[error("Fabric rejected the public configuration")]
    Rejected,
}

/// Canonical Fabric planner, restricted to the observed descriptor snapshot.
pub fn plan_configuration(
    catalog: &FabricCatalog,
    configuration: Value,
) -> Result<nemo_fabric_core::RunPlan, FabricPlanningError> {
    if catalog.fabric_revision != FabricCatalog::bundled().fabric_revision {
        return Err(FabricPlanningError::Unverified);
    }
    let config =
        serde_json::from_value(configuration).map_err(|_| FabricPlanningError::Rejected)?;
    let descriptors = catalog
        .adapters
        .iter()
        .map(|adapter| {
            serde_json::from_value(serde_json::to_value(adapter).expect("descriptor JSON"))
        })
        .collect::<Result<Vec<nemo_fabric_core::ResolvedAdapterDescriptor>, _>>()
        .map_err(|_| FabricPlanningError::Unverified)?;
    let targets = catalog
        .targets
        .iter()
        .cloned()
        .map(serde_json::from_value)
        .collect::<Result<Vec<nemo_fabric_core::ResolvedAdapterTargetDescriptor>, _>>()
        .map_err(|_| FabricPlanningError::Unverified)?;
    nemo_fabric_core::resolve_run_plan_from_descriptors(
        config,
        nemo_fabric_core::ResolveContext::new("/sandbox"),
        &descriptors,
        &targets,
    )
    .map_err(|error| match error {
        nemo_fabric_core::FabricError::UnverifiedAdapterCapability { .. } => {
            FabricPlanningError::Unverified
        }
        _ => FabricPlanningError::Rejected,
    })
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
