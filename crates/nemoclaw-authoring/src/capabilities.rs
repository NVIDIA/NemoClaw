// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::fingerprint::sha256;
use nemoclaw_sdk::config::HarnessKind;

/// Canonical adapter identities and schemas for presenting authoring questions.
/// This is not a compatibility registry: Fabric plans the selected configuration.
#[derive(Clone, Debug)]
pub struct Capabilities {
    pub(crate) release_images: std::collections::BTreeMap<String, Vec<String>>,
    pub(crate) release_tag: Option<String>,
    harnesses: Vec<HarnessKind>,
    pub(crate) fabric_revision: Option<String>,
    pub(crate) catalog_sha256: Option<String>,
    pub(crate) config_schemas: std::collections::BTreeMap<String, serde_json::Value>,
    pub(crate) model_schemas: std::collections::BTreeMap<String, serde_json::Value>,
    pub(crate) targets: Vec<serde_json::Value>,
    pub(crate) schemas: std::collections::BTreeMap<String, Vec<(String, serde_json::Value)>>,
    /// Distinguishes these capabilities from any constructed separately.
    /// Nothing changes capabilities after construction, so a copy has its
    /// original's identity, and resolutions can be reused for it.
    pub(crate) identity: u64,
}

impl Capabilities {
    /// Add the image suggestions of `release`, from its `version-pins.json`.
    /// They don't change compatibility checks: apply pulls and checks the image.
    pub fn with_release_pins(mut self, bytes: &[u8], release: &str) -> Result<Self, String> {
        let pins: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        if pins["release"] != release {
            return Err("the release image pins are another release's".into());
        }
        if pins["components"]["fabric"]["version"].as_str() != self.fabric_revision.as_deref() {
            return Err("the release images use another Fabric revision".into());
        }
        let mut images = std::collections::BTreeMap::<String, Vec<String>>::new();
        for image in pins["agentImages"].as_array().into_iter().flatten() {
            let reference = image["reference"]
                .as_str()
                .ok_or("a release image has no reference")?;
            let adapters = image["adapters"].as_array().into_iter().flatten();
            for adapter in adapters.filter_map(serde_json::Value::as_str) {
                if self
                    .harnesses
                    .iter()
                    .any(|harness| harness.as_str() == adapter)
                {
                    images
                        .entry(adapter.into())
                        .or_default()
                        .push(reference.into());
                }
            }
        }
        self.release_images = images;
        self.release_tag = Some(release.to_owned());
        // Resolutions for the capabilities without these suggestions don't apply.
        self.identity = next_identity();
        Ok(self)
    }

    pub fn available() -> Self {
        Self::from_catalog(nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled_ref())
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
            release_images: Default::default(),
            release_tag: None,
            harnesses,
            fabric_revision: None,
            catalog_sha256: None,
            schemas: Default::default(),
            config_schemas: Default::default(),
            targets: Vec::new(),
            model_schemas: Default::default(),
            identity: next_identity(),
        }
    }

    pub fn harnesses(&self) -> &[HarnessKind] {
        &self.harnesses
    }

    /// Which release supplied this suggestion, not proof of runtime compatibility.
    pub fn image_release(&self, reference: &str) -> Option<&str> {
        self.release_images
            .values()
            .any(|images| images.iter().any(|image| image == reference))
            .then_some(self.release_tag.as_deref())
            .flatten()
    }
}

fn next_identity() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod release_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn release_suggestions_come_only_from_this_release_its_fabric_revision_and_known_adapters() {
        let reference = format!(
            "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:{}",
            "a".repeat(64)
        );
        let fabric = &nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled_ref().fabric_revision;
        let load = |release: &str, fabric: &str, adapter: &str| {
            let pins = json!({
                "release": release,
                "components": {"fabric": {"version": fabric}},
                "agentImages": [{"reference": reference, "adapters": [adapter]}]
            });
            Capabilities::available().with_release_pins(pins.to_string().as_bytes(), "v0.1.0-rc.5")
        };
        let capabilities = load("v0.1.0-rc.5", fabric, "nvidia.fabric.hermes").unwrap();
        assert_eq!(capabilities.image_release(&reference), Some("v0.1.0-rc.5"));
        assert!(load("v0.1.0", fabric, "nvidia.fabric.hermes").is_err());
        assert!(load("v0.1.0-rc.5", &"f".repeat(40), "nvidia.fabric.hermes").is_err());
        let unknown = load("v0.1.0-rc.5", fabric, "unknown.adapter").unwrap();
        assert_eq!(unknown.image_release(&reference), None);
    }
}
