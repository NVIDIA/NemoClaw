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

/// Whether an image can run a configuration's harness: it provides the
/// selected adapter, that adapter declares the interfaces the configuration
/// sets, and an explicit filesystem policy lets that adapter read its files. Whether the image's Fabric runtime is compatible is Fabric's to
/// report when the agent starts. Whether the
/// harness accepts the configuration is Fabric's to decide, inside the sandbox
/// when the agent is configured.
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
        checks.extend(interface_checks(
            &adapter.descriptor,
            &request.configuration,
        ));
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

const INTERFACES: &str = "harness.settings.interfaces";

/// Whether each interface the configuration sets satisfies the adapter's
/// descriptor. Fabric's adapters list their interfaces, and each one's schema,
/// under `settings_schema.properties.interfaces`, closed at both levels; an
/// adapter that declares none supports none. Each interface object is checked
/// against its own schema, so a missing port, a wrong type or an out-of-range
/// value fails the plan before apply instead of failing Fabric's check inside
/// the sandbox after NemoClaw has created resources. Settings outside the
/// interfaces, and conditions across them such as OpenClaw's `port_range`
/// with a dashboard port, are still Fabric's to check when it plans the agent.
fn interface_checks(descriptor: &Value, configuration: &Value) -> Vec<CapabilityCheck> {
    let Some(requested) = configuration.pointer("/harness/settings/interfaces") else {
        return Vec::new();
    };
    let unsupported = |path: String| CapabilityCheck {
        requirement: "harness_interfaces".into(),
        status: Support::Unsupported,
        // A name that isn't safe to print is reported by its parent setting.
        reason: format!(
            "{}: the image's adapter does not support this interface setting",
            if diagnostic_field(&path) == path {
                path.as_str()
            } else {
                INTERFACES
            }
        ),
    };
    let declared = descriptor
        .pointer("/settings_schema/properties/interfaces/properties")
        .and_then(Value::as_object);
    let Some(requested) = requested.as_object() else {
        // The value's type is Fabric's to check, unless the adapter takes none.
        return match declared {
            Some(_) => Vec::new(),
            None => vec![unsupported(INTERFACES.into())],
        };
    };
    let mut checks = Vec::new();
    for (name, settings) in requested {
        let path = format!("{INTERFACES}.{name}");
        let Some(schema) = declared.and_then(|declared| declared.get(name)) else {
            checks.push(unsupported(path));
            continue;
        };
        let fields = schema.get("properties").and_then(Value::as_object);
        for field in settings
            .as_object()
            .into_iter()
            .flat_map(|settings| settings.keys())
        {
            if !fields.is_some_and(|fields| fields.contains_key(field)) {
                checks.push(unsupported(format!("{path}.{field}")));
            }
        }
        let root = descriptor
            .pointer("/settings_schema")
            .unwrap_or(&Value::Null);
        for (field, problem) in schema_problems(root, schema, settings) {
            let field = format!("{path}{field}");
            checks.push(CapabilityCheck {
                requirement: "harness_interfaces".into(),
                status: Support::Unsupported,
                reason: if diagnostic_field(&field) == field {
                    format!("{field}: {problem}")
                } else {
                    format!("{path}: does not satisfy the image's adapter schema")
                },
            });
        }
    }
    checks.sort_by(|left, right| left.reason.cmp(&right.reason));
    checks.dedup();
    if checks.is_empty() {
        checks.push(CapabilityCheck {
            requirement: "harness_interfaces".into(),
            status: Support::Supported,
            reason: "the image's adapter declares each configured interface setting".into(),
        });
    }
    checks
}

/// Refuses every schema reference outside the descriptor, so checking a schema
/// an image advertises never reads the network or the filesystem.
struct OfflineSchemas;

impl jsonschema::Retrieve for OfflineSchemas {
    fn retrieve(
        &self,
        uri: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err(format!("external schema retrieval is disabled: {uri}").into())
    }
}

/// Where `settings` breaks `schema`, an interface's schema within the
/// adapter's `settings_schema` (`root`), as field suffixes such as `.port`
/// with a fixed description; never the rejected value. Unknown fields are
/// reported by name elsewhere. A schema that doesn't compile offline is left
/// to Fabric.
fn schema_problems(root: &Value, schema: &Value, settings: &Value) -> Vec<(String, &'static str)> {
    use jsonschema::{error::ValidationErrorKind as Kind, paths::LocationSegment};
    let mut schema = schema.clone();
    // The interface's schema can use the dialect and definitions of the
    // settings schema it came from.
    if let Some(object) = schema.as_object_mut() {
        for key in ["$schema", "$defs", "definitions"] {
            if let Some(value) = root.get(key) {
                object.entry(key).or_insert_with(|| value.clone());
            }
        }
    }
    let Ok(validator) = jsonschema::options()
        .with_retriever(OfflineSchemas)
        .build(&schema)
    else {
        return Vec::new();
    };
    let mut problems = Vec::new();
    for error in validator.iter_errors(settings) {
        let mut field: String = error
            .instance_path()
            .iter()
            .map(|segment| match segment {
                LocationSegment::Property(name) => format!(".{name}"),
                LocationSegment::Index(index) => format!("[{index}]"),
            })
            .collect();
        let problem = match error.kind() {
            Kind::AdditionalProperties { .. } | Kind::UnevaluatedProperties { .. } => continue,
            Kind::Required { property } => {
                field.push('.');
                field.push_str(property.as_str().unwrap_or_default());
                "is required by the image's adapter"
            }
            Kind::Type { .. } => "has a type the image's adapter does not accept",
            Kind::Minimum { .. }
            | Kind::Maximum { .. }
            | Kind::ExclusiveMinimum { .. }
            | Kind::ExclusiveMaximum { .. }
            | Kind::MultipleOf { .. } => "is out of the range the image's adapter accepts",
            Kind::Enum { .. } | Kind::Constant { .. } => {
                "is not a value the image's adapter accepts"
            }
            _ => "does not satisfy the image's adapter schema",
        };
        problems.push((field, problem));
    }
    problems
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
