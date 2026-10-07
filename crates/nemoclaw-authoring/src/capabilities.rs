// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::fingerprint::sha256;
use nemoclaw_sdk::config::HarnessKind;

/// Canonical adapter identities and schemas for presenting authoring questions.
/// This is not a compatibility registry: Fabric plans the selected configuration.
#[derive(Clone, Debug)]
pub struct Capabilities {
    harnesses: Vec<HarnessKind>,
    pub(crate) fabric_revision: Option<String>,
    pub(crate) catalog_sha256: Option<String>,
    pub(crate) config_schemas: std::collections::BTreeMap<String, serde_json::Value>,
    pub(crate) model_schemas: std::collections::BTreeMap<String, serde_json::Value>,
    pub(crate) targets: Vec<serde_json::Value>,
    pub(crate) schemas: std::collections::BTreeMap<String, Vec<(String, serde_json::Value)>>,
}

impl Capabilities {
    pub fn available() -> Self {
        Self::from_catalog(&nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled())
    }

    pub fn from_catalog(catalog: &nemoclaw_sdk::fabric_catalog::FabricCatalog) -> Self {
        let mut capabilities = Self::from_harnesses(
            catalog
                .adapters
                .iter()
                .filter_map(|adapter| adapter.descriptor["adapter_id"].as_str()?.parse().ok()),
        );
        capabilities.fabric_revision = Some(catalog.fabric_revision.clone());
        let snapshot = serde_json::to_vec(catalog).expect("Fabric catalog serializes");
        capabilities.catalog_sha256 = Some(sha256(&snapshot));
        capabilities.targets = catalog.targets.clone();
        for adapter in &catalog.adapters {
            let Some(id) = adapter.descriptor["adapter_id"].as_str() else {
                continue;
            };
            if let Some(schema) = adapter
                .descriptor
                .get("model_schema")
                .filter(|schema| !schema.is_null())
            {
                capabilities.model_schemas.insert(id.into(), schema.clone());
            }
            if let Some(schema) = adapter.descriptor["config"].get("schema") {
                capabilities
                    .config_schemas
                    .insert(id.into(), schema.clone());
            }
            if let Some(schema) = adapter
                .descriptor
                .get("settings_schema")
                .filter(|schema| !schema.is_null())
            {
                capabilities
                    .schemas
                    .entry(id.into())
                    .or_default()
                    .push((id.into(), schema.clone()));
            }
        }
        capabilities
    }

    pub fn from_harnesses(harnesses: impl IntoIterator<Item = HarnessKind>) -> Self {
        let mut harnesses: Vec<_> = harnesses.into_iter().collect();
        harnesses.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        harnesses.dedup();
        Self {
            harnesses,
            fabric_revision: None,
            catalog_sha256: None,
            schemas: Default::default(),
            config_schemas: Default::default(),
            targets: Vec::new(),
            model_schemas: Default::default(),
        }
    }

    pub fn harnesses(&self) -> &[HarnessKind] {
        &self.harnesses
    }
}
