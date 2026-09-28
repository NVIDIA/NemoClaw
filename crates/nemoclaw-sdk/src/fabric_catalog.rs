// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Fabric descriptor metadata, without importing adapters or starting runtimes.

use serde::{Deserialize, Serialize};

pub const IMAGE_CATALOG_LABEL: &str = "io.nemoclaw.fabric.catalog";

/// Source-matched metadata. Bundled records describe possible adapters, not
/// evidence that an adapter is installed or executable on a selected target.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricCatalog {
    pub schema_version: u32,
    pub fabric_revision: String,
    pub source_sha256: String,
    pub adapters: Vec<FabricAdapter>,
    #[serde(default)]
    pub targets: Vec<serde_json::Value>,
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
    fn malformed_image_metadata_is_not_an_empty_capability_list() {
        let mut catalog = FabricCatalog::bundled();
        catalog.schema_version = 99;
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
        catalog.schema_version = 2;
        catalog.adapters[0].descriptor["contract_version"] = "substituted".into();
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
    }
}
