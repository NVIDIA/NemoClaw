// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Fabric descriptor metadata, without importing adapters or starting runtimes.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const IMAGE_CATALOG_LABEL: &str = "io.nemoclaw.fabric.catalog";

/// Source-matched metadata. Bundled records describe possible adapters, not
/// evidence that an adapter is installed or executable on a selected target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricCatalog {
    pub schema_version: u32,
    pub fabric_revision: String,
    pub source_sha256: String,
    /// Present only when the selected image advertises its bridge contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bridge: Option<BridgeCapabilities>,
    pub adapters: Vec<FabricAdapter>,
    #[serde(default)]
    pub targets: Vec<serde_json::Value>,
    /// Absolute paths an adapter reads in this image, keyed by adapter ID.
    /// The image build records its own layout here and leaves Fabric's
    /// descriptors unedited; the bundled snapshot describes no image.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub runtime_files: BTreeMap<String, Vec<PathBuf>>,
    /// Present only for an installed image, never inferred from the bundled descriptors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Box<crate::image_runtime::ImageRuntime>>,
}

/// Image-owned bridge metadata, separate from Fabric adapter descriptors.
/// Fields added within an interface version are additive, so unknown fields
/// are ignored rather than rejected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeCapabilities {
    pub interface_version: u32,
    pub operations: Vec<String>,
    pub health_checks: Vec<String>,
    /// Ways `--config` and `--input` accept JSON: `file` and `stdin`.
    #[serde(default)]
    pub input_sources: Vec<String>,
}

impl BridgeCapabilities {
    pub fn supports_interface(&self) -> bool {
        let operations = [
            "validate",
            "prepare",
            "configure",
            "check",
            "invoke",
            "serve",
        ];
        self.interface_version == 1
            && self.operations.len() == operations.len()
            && operations
                .iter()
                .all(|operation| self.operations.iter().any(|value| value == operation))
            && self.health_checks.len() <= 3
            && self
                .health_checks
                .iter()
                .zip(["live", "active", "ready"])
                .all(|(actual, expected)| actual == expected)
            // The provider delivers configuration and invocation input on stdin.
            && self.input_sources.iter().any(|source| source == "stdin")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricAdapter {
    pub descriptor: serde_json::Value,
    pub provenance: serde_json::Value,
}
impl FabricAdapter {
    pub fn adapter_id(&self) -> &str {
        self.descriptor["adapter_id"].as_str().unwrap_or_default()
    }
}

impl FabricCatalog {
    pub fn bundled() -> Self {
        Self::from_json(include_str!("../../../image/fabric/catalog.json"))
            .expect("generated Fabric catalog must be valid")
    }

    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        let catalog: Self = serde_json::from_str(json)?;
        let valid_digest = |value: &str, len| {
            value.len() == len && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        };
        if catalog.schema_version != 2
            || !valid_digest(&catalog.fabric_revision, 40)
            || !valid_digest(&catalog.source_sha256, 64)
            || catalog.adapters.iter().any(|adapter| {
                adapter.descriptor["contract_version"] != nemo_fabric_core::ADAPTER_CONTRACT_VERSION
                    || serde_json::from_value::<nemo_fabric_core::ResolvedAdapterDescriptor>(
                        serde_json::to_value(adapter).expect("serializable descriptor"),
                    )
                    .is_err()
            })
            || catalog.targets.iter().any(|target| {
                target["descriptor"]["contract_version"]
                    != nemo_fabric_core::ADAPTER_CONTRACT_VERSION
                    || serde_json::from_value::<nemo_fabric_core::ResolvedAdapterTargetDescriptor>(
                        target.clone(),
                    )
                    .is_err()
            })
            || catalog
                .runtime
                .as_ref()
                .is_some_and(|runtime| !runtime.valid(&catalog.adapters))
            || catalog.runtime_files.iter().any(|(adapter_id, files)| {
                !catalog
                    .adapters
                    .iter()
                    .any(|adapter| adapter.adapter_id() == adapter_id)
                    || files.iter().any(|file| {
                        !file.to_str().is_some_and(|path| {
                            path.starts_with('/') && !path.split('/').any(|part| part == "..")
                        })
                    })
            })
        {
            return Err(<serde_json::Error as serde::de::Error>::custom(
                "unsupported or inconsistent Fabric catalog metadata",
            ));
        }
        Ok(catalog)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_keeps_only_canonical_descriptor_records() {
        let catalog = FabricCatalog::bundled();
        assert!(!catalog.adapters.is_empty());
        for adapter in catalog.adapters {
            assert!(!adapter.adapter_id().is_empty());
            assert!(
                adapter
                    .provenance
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
            );
        }
    }

    #[test]
    fn image_runtime_layout_survives_discovery_without_sdk_path_defaults() {
        let mut encoded = serde_json::to_value(FabricCatalog::bundled()).unwrap();
        let binaries: BTreeMap<_, _> = encoded["adapters"]
            .as_array()
            .unwrap()
            .iter()
            .map(|record| {
                (
                    record["descriptor"]["adapter_id"]
                        .as_str()
                        .unwrap()
                        .to_owned(),
                    vec!["/srv/python3.99", "/srv/bun"],
                )
            })
            .collect();
        let runtime = serde_json::json!({
            "schema_version": 1,
            "command": ["/srv/python3.99", "/srv/bridge.py"],
            "environment": {"ADAPTER_PYTHON":"/srv/python3.99", "PATH":"/srv"},
            "required_paths": ["/srv"],
            "policy": {"version":1,"filesystem_policy":{"read_only":["/srv"],"read_write":["/data"]},"process":{"run_as_user":"1234","run_as_group":"1234"},"network_policies":{}},
            "binaries": binaries,
        });
        encoded["runtime"] = runtime.clone();
        let decoded = FabricCatalog::from_json(&encoded.to_string()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap()["runtime"], runtime);
        for (pointer, invalid) in [
            ("/runtime/schema_version", serde_json::json!(9)),
            ("/runtime/command/0", serde_json::json!("python")),
            (
                "/runtime/required_paths/0",
                serde_json::json!("/srv/../etc"),
            ),
            ("/runtime/binaries", serde_json::json!({})),
        ] {
            let mut bad = encoded.clone();
            *bad.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                FabricCatalog::from_json(&bad.to_string()).is_err(),
                "accepted {pointer}"
            );
        }
    }

    #[test]
    fn malformed_image_metadata_is_not_an_empty_capability_list() {
        let mut catalog = FabricCatalog::bundled();
        catalog.schema_version = 99;
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
        catalog.schema_version = 2;
        catalog.adapters[0].descriptor["contract_version"] = "substituted".into();
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
    }

    #[test]
    fn runtime_files_must_name_a_cataloged_adapter_and_absolute_paths() {
        let mut catalog = FabricCatalog::bundled();
        let adapter_id = catalog.adapters[0].adapter_id().to_owned();
        catalog
            .runtime_files
            .insert(adapter_id.clone(), vec!["/opt/runtime".into()]);
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_ok());
        catalog
            .runtime_files
            .insert(adapter_id, vec!["opt/runtime".into()]);
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
        catalog.runtime_files.insert(
            catalog.adapters[0].adapter_id().to_owned(),
            vec!["/opt/runtime/../../etc".into()],
        );
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
        catalog.runtime_files.clear();
        catalog
            .runtime_files
            .insert("org.fixture.absent".into(), vec!["/opt/runtime".into()]);
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
    }
}
