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

/// Whether an image can run a configuration's harness: its catalog matches
/// NemoClaw's Fabric revision, it provides the selected adapter, and an
/// explicit filesystem policy lets that adapter read its files. Whether the
/// harness accepts the configuration is Fabric's to decide, inside the sandbox
/// when the agent is configured.
pub fn assess_fabric(catalog: &FabricCatalog, request: &FabricRequirements) -> CompatibilityReport {
    let adapter_id = request
        .configuration
        .pointer("/harness/adapter_id")
        .and_then(Value::as_str);
    let mut checks = Vec::new();
    if catalog.fabric_revision != FabricCatalog::bundled().fabric_revision {
        checks.push(CapabilityCheck {
            requirement: "fabric_contract".into(),
            status: Support::Unknown,
            reason: "fabric_contract: the image does not establish the SDK Fabric revision".into(),
        });
    }
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
