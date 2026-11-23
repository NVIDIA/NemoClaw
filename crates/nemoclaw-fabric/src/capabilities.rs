// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Interpret advertised Fabric metadata without treating absent claims as support.
//! Tool support here means descriptor-advertised tool configuration, not proof
//! that an inference model can execute tool calls.
use crate::catalog::FabricCatalog;
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
    /// Where the user wrote each configuration field, keyed by Fabric path,
    /// so a rejection names the authored field; see `fabric_config::Provenance`.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub provenance: std::collections::BTreeMap<String, String>,
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

/// Whether an image can run a configuration's harness: it provides the
/// selected adapter, Fabric's own compatibility check accepts the configuration
/// against that adapter's descriptor, and an explicit filesystem policy lets the
/// adapter read its files. Whether the image's Fabric runtime is compatible is
/// Fabric's to report when the agent starts, as is a workflow when the image's
/// catalog records no workflow targets.
pub fn assess_fabric(catalog: &FabricCatalog, request: &FabricRequirements) -> CompatibilityReport {
    let adapter_id = request
        .configuration
        .pointer("/harness/adapter_id")
        .and_then(Value::as_str);
    let mut checks = Vec::new();
    let adapter = adapter_id.and_then(|id| {
        catalog
            .adapters
            .iter()
            .find(|adapter| adapter.adapter_id() == id)
    });
    checks.push(match adapter {
        Some(_) => CapabilityCheck {
            requirement: "fabric_adapter".into(),
            status: Support::Supported,
            reason: "the image provides the selected adapter".into(),
        },
        None => CapabilityCheck {
            requirement: "fabric_adapter".into(),
            status: Support::Unsupported,
            reason: "harness.adapter_id: the image does not provide the selected adapter".into(),
        },
    });
    if let Some(adapter) = adapter {
        checks.extend(configuration_checks(catalog, adapter, request));
    }
    if let (Some(adapter), Some(grants)) = (adapter, &request.filesystem_read) {
        // Fabric declares the adapter's own files; the image build declares
        // where its layout installs the harness. The policy must allow both.
        let adapter_files: Vec<std::path::PathBuf> = adapter
            .descriptor
            .pointer("/requirements/files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(std::path::PathBuf::from)
            .collect();
        let image_files = catalog
            .runtime_files
            .get(adapter.adapter_id())
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
        for file in adapter_files
            .iter()
            .chain(image_files)
            .chain(runtime_paths.iter())
        {
            let allowed = file
                .to_str()
                .is_some_and(|path| nemoclaw_openshell::runtime::path_is_granted(path, grants));
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
        adapter_id: adapter_id.map(str::to_owned),
        checks,
    }
}

const CONFIGURATION: &str = "fabric_configuration";

/// Whether Fabric's own compatibility check accepts the configuration against
/// the image's adapter descriptor. Fabric decides what its adapters accept, so
/// this reports each issue it finds, with the field the user wrote where the
/// request records one, instead of repeating any of its rules. A workflow needs
/// its target's descriptor, which the image's catalog registers by ID; whether
/// the target suits the adapter is Fabric's to decide. A target the catalog
/// doesn't register is unsupported, unless the catalog registers no targets at
/// all. Such a catalog may predate workflow targets, so the check is left to
/// Fabric when the agent starts.
fn configuration_checks(
    catalog: &FabricCatalog,
    adapter: &crate::catalog::FabricAdapter,
    request: &FabricRequirements,
) -> Vec<CapabilityCheck> {
    use nemo_fabric_core::{
        AdapterDescriptor, AdapterTargetDescriptor, FabricConfig, FabricError,
        inspect_adapter_config,
    };
    let unsupported = |reason: &str| CapabilityCheck {
        requirement: CONFIGURATION.into(),
        status: Support::Unsupported,
        reason: reason.into(),
    };
    let Ok(config) = serde_json::from_value::<FabricConfig>(request.configuration.clone()) else {
        return vec![unsupported(
            "configuration: is not a valid Fabric configuration",
        )];
    };
    let Ok(descriptor) = serde_json::from_value::<AdapterDescriptor>(adapter.descriptor.clone())
    else {
        return vec![unsupported(
            "the image's descriptor for the selected adapter is malformed",
        )];
    };
    let target = match &config.workflow {
        None => None,
        Some(workflow) => {
            let found = catalog.targets.iter().find_map(|target| {
                serde_json::from_value::<AdapterTargetDescriptor>(target["descriptor"].clone())
                    .ok()
                    .filter(|target| target.id == workflow.target_id)
            });
            let field = authored_field(&request.provenance, "workflow.target_id");
            match found {
                Some(target) => Some(target),
                None if catalog.targets.is_empty() => {
                    return vec![CapabilityCheck {
                        requirement: CONFIGURATION.into(),
                        status: Support::Unknown,
                        reason: format!(
                            "{field}: the image's catalog records no workflow targets; Fabric checks the workflow when the agent starts"
                        ),
                    }];
                }
                None => {
                    return vec![unsupported(&format!(
                        "{field}: the image does not register the selected workflow target"
                    ))];
                }
            }
        }
    };
    // Fabric's reasons are fixed strings, never configured values.
    let issues: Vec<(String, String)> =
        match inspect_adapter_config(config, &descriptor, target.as_ref(), true) {
            Ok(inspection) => inspection
                .issues
                .into_iter()
                .map(|issue| (issue.field, issue.reason))
                .collect(),
            Err(
                FabricError::InvalidConfig { field, reason }
                | FabricError::AdapterCompatibility { field, reason, .. },
            ) => vec![(field, reason)],
            Err(_) => {
                return vec![unsupported(
                    "configuration: cannot be inspected against the image's adapter",
                )];
            }
        };
    let mut checks: Vec<CapabilityCheck> = issues
        .iter()
        .map(|(field, reason)| {
            unsupported(&format!(
                "{}: {reason}",
                authored_field(&request.provenance, field)
            ))
        })
        .collect();
    // The selected model is configured as `default` and under its own role,
    // which are one authored field.
    let mut seen = std::collections::BTreeSet::new();
    checks.retain(|check| seen.insert(check.reason.clone()));
    if checks.is_empty() {
        checks.push(CapabilityCheck {
            requirement: CONFIGURATION.into(),
            status: Support::Supported,
            reason: "the image's adapter accepts the configuration".into(),
        });
    }
    checks
}

/// The field the user wrote for a Fabric configuration path: the longest
/// recorded path that is the field or one of its parents, with the remainder
/// appended, else the sandbox's, else Fabric's own path. A name that isn't safe
/// to print is reported by its nearest parent that is.
fn authored_field(provenance: &std::collections::BTreeMap<String, String>, field: &str) -> String {
    let mut field = field;
    loop {
        if diagnostic_field(field) == field {
            break;
        }
        match field.rsplit_once(['.', '[']) {
            Some((parent, _)) => field = parent,
            None => {
                field = "configuration";
                break;
            }
        }
    }
    let mut prefix = field;
    loop {
        if let Some(authored) = provenance.get(prefix).filter(|_| !prefix.is_empty()) {
            return format!("{authored}{}", &field[prefix.len()..]);
        }
        match prefix.rsplit_once(['.', '[']) {
            Some((parent, _)) => prefix = parent,
            None => break,
        }
    }
    match provenance.get("") {
        Some(sandbox) => format!("{sandbox}: {field}"),
        None => field.to_owned(),
    }
}

/// A field path or adapter name safe to show in a diagnostic, else `configuration`.
///
/// Field paths are public identifiers, never rejected values or schema prose.
/// Control characters and interpolation syntax are rejected instead of rendered.
pub fn diagnostic_field(value: &str) -> &str {
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

/// What an image says about its Fabric catalog, and whether it suits a sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricObservation {
    pub status: nemoclaw_backend::ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub image_id: Option<String>,
    pub catalog: Option<FabricCatalog>,
    #[serde(default)]
    pub image: ImageMetadata,
    #[serde(default)]
    pub compatibility: Option<CompatibilityReport>,
}

/// The images an engine holds that install one adapter's runtime, newest
/// first, by the `NAME@sha256:DIGEST` reference a sandbox pins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentImagesObservation {
    pub status: nemoclaw_backend::ObservationStatus,
    pub reason: Option<String>,
    pub references: Vec<String>,
}

impl FabricObservation {
    /// A read that could not be made, recorded as unknown rather than absent.
    pub fn unknown(reason: &str) -> Self {
        Self {
            status: nemoclaw_backend::ObservationStatus::Unknown,
            reason: Some(reason.into()),
            source: "engine_image_inspect".into(),
            image_id: None,
            catalog: None,
            image: Default::default(),
            compatibility: None,
        }
    }
}
