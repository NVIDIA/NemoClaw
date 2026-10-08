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
    let result = plan_configuration_detailed(catalog, request.configuration.clone());
    let mut checks = vec![match &result {
        Ok(_) => CapabilityCheck {
            requirement: "fabric_plan".into(),
            status: Support::Supported,
            reason: "Fabric accepted the configuration against the selected descriptor snapshot"
                .into(),
        },
        Err((_, check)) => check.clone(),
    }];
    if let (Ok(plan), Some(grants)) = (&result, &request.filesystem_read)
        && let Some(descriptor) = &plan.adapter_descriptor
    {
        // Fabric declares the adapter's own files; the image build declares
        // where its layout installs the harness. The policy must allow both.
        let image_files = catalog
            .runtime_files
            .get(&descriptor.descriptor.adapter_id)
            .into_iter()
            .flatten();
        let runtime_paths: Vec<std::path::PathBuf> = catalog
            .runtime
            .as_ref()
            .map(|runtime| {
                runtime
                    .required_paths
                    .iter()
                    .map(std::path::PathBuf::from)
                    .collect()
            })
            .unwrap_or_default();
        for file in descriptor
            .descriptor
            .requirements
            .files
            .iter()
            .chain(image_files)
            .chain(runtime_paths.iter())
        {
            let allowed = file
                .to_str()
                .is_some_and(|path| crate::image_runtime::path_is_granted(path, grants));
            let path = file.to_string_lossy();
            let path = diagnostic_field(&path);
            checks.push(CapabilityCheck {
                requirement: "deployment_filesystem_grant".into(),
                status: if allowed {
                    Support::Supported
                } else {
                    Support::Unsupported
                },
                reason: if allowed {
                    format!("explicit filesystem policy grants read access to {path}")
                } else {
                    format!("explicit filesystem policy must grant read access to {path}")
                },
            });
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
    plan_configuration_detailed(catalog, configuration).map_err(|(kind, _)| kind)
}

// Field paths are public identifiers, never rejected values or schema prose.
// Reject control characters and interpolation syntax instead of rendering them.
pub(crate) fn diagnostic_field(value: &str) -> &str {
    if !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/[]".contains(&byte))
    {
        value
    } else {
        "configuration"
    }
}

type PlanningFailure = (FabricPlanningError, CapabilityCheck);
fn planning_failure(kind: FabricPlanningError, field: &str, reason: &str) -> PlanningFailure {
    (
        kind,
        CapabilityCheck {
            requirement: "fabric_plan".into(),
            status: match kind {
                FabricPlanningError::Unverified => Support::Unknown,
                FabricPlanningError::Rejected => Support::Unsupported,
            },
            reason: format!("{}: {reason}", diagnostic_field(field)),
        },
    )
}

fn plan_configuration_detailed(
    catalog: &FabricCatalog,
    configuration: Value,
) -> Result<nemo_fabric_core::RunPlan, PlanningFailure> {
    use FabricPlanningError::{Rejected, Unverified};
    if catalog.fabric_revision != FabricCatalog::bundled().fabric_revision {
        return Err(planning_failure(
            Unverified,
            "fabric_contract",
            "the image does not establish the SDK Fabric revision",
        ));
    }
    let config = serde_json::from_value(configuration.clone()).map_err(|_| {
        planning_failure(
            Rejected,
            "configuration",
            "invalid public Fabric configuration",
        )
    })?;
    let descriptors = catalog
        .adapters
        .iter()
        .map(|adapter| {
            serde_json::from_value(serde_json::to_value(adapter).expect("descriptor JSON"))
        })
        .collect::<Result<Vec<nemo_fabric_core::ResolvedAdapterDescriptor>, _>>()
        .map_err(|_| {
            planning_failure(
                Unverified,
                "adapter_descriptor",
                "the image does not establish valid adapter metadata",
            )
        })?;
    let targets = catalog
        .targets
        .iter()
        .cloned()
        .map(serde_json::from_value)
        .collect::<Result<Vec<nemo_fabric_core::ResolvedAdapterTargetDescriptor>, _>>()
        .map_err(|_| {
            planning_failure(
                Unverified,
                "target_descriptor",
                "the image does not establish valid target metadata",
            )
        })?;
    nemo_fabric_core::resolve_run_plan_from_descriptors(
        config,
        nemo_fabric_core::ResolveContext::new("/sandbox"),
        &descriptors,
        &targets,
    )
    .map_err(|error| {
        use nemo_fabric_core::FabricError::*;
        let (kind, field, reason) = match &error {
            UnverifiedAdapterCapability { field, .. } => (Unverified, field.as_str(), "adapter metadata does not establish this capability"),
            AdapterCompatibility { field, .. } => (Rejected, field.as_str(), "the selected adapter rejects this configuration field"),
            InvalidHarnessSettings { settings_path, .. } => (Rejected, settings_path.as_str(), "the value does not satisfy the adapter settings schema"),
            InvalidWorkflow { workflow_path, .. } => (Rejected, workflow_path.as_str(), "the value does not satisfy the workflow schema"),
            InvalidToolDefinition { definition_path, .. } => (Rejected, definition_path.as_str(), "the value does not satisfy the tool definition schema"),
            InvalidAdapterExtension { extension_path, .. } => (Rejected, extension_path.as_str(), "the value does not satisfy the adapter extension schema"),
            InvalidConfig { field, .. } => (Rejected, field.as_str(), "invalid public Fabric configuration field"),
            AdapterDescriptorUnsupported { field, .. } => (Rejected, *field, "the adapter descriptor excludes this configuration field"),
            UnknownAdapter { .. } => (Rejected, "harness.adapter_id", "the selected adapter is absent from the image catalog"),
            UnknownAdapterTarget { .. } => (Rejected, "workflow.target_id", "the selected target is absent from the image catalog"),
            _ => (Rejected, "fabric_plan", "Fabric rejected the configuration against the selected descriptor snapshot"),
        };
        let mut failure = planning_failure(kind, field, reason);
        if field.starts_with("models.") && field.ends_with(".max_tokens") {
            let routes = configuration["models"].as_object().into_iter().flat_map(|models| models.iter())
                .filter(|(_, model)| model.get("max_tokens").is_some())
                .take(16).map(|(name, _)| diagnostic_field(name)).collect::<Vec<_>>().join(", ");
            failure.1.reason.push_str(&format!("; models.max_tokens corresponds to overrides.maxTokens on model routes {routes}; remove the override or choose an adapter that accepts it"));
        }
        failure
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
/// Compare platforms only when execution-engine metadata is supplied; an
/// external gateway's image store does not establish its execution platform.
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
    report.checks.push(check(
        "bridge_interface",
        if catalog
            .and_then(|catalog| catalog.bridge.as_ref())
            .is_some_and(|bridge| bridge.supports_interface())
        {
            Support::Supported
        } else {
            Support::Unknown
        },
    ));
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
