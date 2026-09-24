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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricAdapter {
    pub harness: String,
    pub adapter_id: String,
    pub adapter_kind: String,
    pub source: String,
    /// Canonical descriptor, including settings and model schemas when provided.
    pub descriptor: serde_json::Value,
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
        if catalog.schema_version != 1
            || !valid_digest(&catalog.fabric_revision, 40)
            || !valid_digest(&catalog.source_sha256, 64)
            || catalog.adapters.iter().any(|adapter| {
                adapter.harness.is_empty()
                    || adapter.source.is_empty()
                    || adapter.adapter_id.is_empty()
                    || adapter.adapter_kind.is_empty()
                    || adapter.descriptor["contract_version"] != "fabric.adapter/v1alpha2"
                    || adapter.descriptor["adapter_id"] != adapter.adapter_id
                    || adapter.descriptor["adapter_kind"] != adapter.adapter_kind
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
    fn bundled_catalog_keeps_canonical_upstream_and_local_descriptors() {
        let catalog = FabricCatalog::bundled();
        assert!(
            catalog
                .adapters
                .iter()
                .any(|item| item.harness == "opencode")
        );
        assert!(
            catalog
                .adapters
                .iter()
                .any(|item| item.adapter_id == "nemoclaw.local.openclaw")
        );
        assert!(
            catalog
                .adapters
                .iter()
                .any(|item| item.adapter_id == "nvidia.fabric.langchain.deepagents")
        );
    }

    #[test]
    fn malformed_image_metadata_is_not_an_empty_capability_list() {
        let mut catalog = FabricCatalog::bundled();
        catalog.schema_version = 99;
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
        catalog.schema_version = 1;
        catalog.adapters[0].adapter_id = "substituted".into();
        assert!(FabricCatalog::from_json(&serde_json::to_string(&catalog).unwrap()).is_err());
    }
}
