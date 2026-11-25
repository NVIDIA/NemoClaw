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
    /// Use the selected release's image suggestions without changing compatibility checks.
    pub fn with_release_pins(
        mut self,
        bytes: &[u8],
        release: Option<&str>,
    ) -> Result<Self, String> {
        let pins: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|_| "Release image pins are not valid JSON".to_owned())?;
        let tag = pins["release"]
            .as_str()
            .filter(|tag| {
                tag.starts_with("v0.1.")
                    && tag
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
            })
            .ok_or("Release image pins have no valid release tag")?;
        if release.is_some_and(|expected| tag != expected) {
            return Err("Release image pins do not match this CLI release".into());
        }
        let mut images: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        if let Some(entries) = pins.get("agentImages") {
            for entry in entries.as_array().ok_or("Invalid release agent images")? {
                let reference = entry["reference"]
                    .as_str()
                    .ok_or("Missing release image reference")?;
                let valid = reference
                    .rsplit_once("@sha256:")
                    .is_some_and(|(name, digest)| {
                        name.starts_with("ghcr.io/nvidia/nemoclaw/v1/")
                            && name
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"._/-".contains(&c))
                            && digest.len() == 64
                            && digest
                                .bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    });
                let listed = pins["components"].as_object().is_some_and(|components| {
                    components
                        .values()
                        .any(|component| component["image"].as_str() == Some(reference))
                });
                if !valid
                    || !listed
                    || entry["fabricRevision"].as_str() != self.fabric_revision.as_deref()
                {
                    return Err(
                        "Release image pins are unpinned or use another Fabric revision".into(),
                    );
                }
                let adapters = entry["adapters"]
                    .as_array()
                    .filter(|ids| !ids.is_empty())
                    .ok_or("Release image has no adapters")?;
                for adapter in adapters {
                    let id = adapter.as_str().ok_or("Invalid release image adapter")?;
                    if self.harnesses.iter().any(|harness| harness.as_str() == id) {
                        let references = images.entry(id.into()).or_default();
                        if !references.iter().any(|known| known == reference) {
                            references.push(reference.into());
                        }
                    }
                }
            }
        }
        self.release_images = images;
        self.release_tag = Some(tag.to_owned());
        // A clone enriched with release data must not reuse resolutions for its original.
        self.identity = Self::from_harnesses([]).identity;
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
            identity: {
                static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            },
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

#[cfg(test)]
mod release_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn release_suggestions_refuse_mismatched_unpinned_or_unlisted_images() {
        let reference = format!(
            "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:{}",
            "a".repeat(64)
        );
        let pins = json!({
            "release":"v0.1.0-rc.5", "components":{"hermes":{"image":reference}},
            "agentImages":[{"reference":reference,
                "fabricRevision":nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled_ref().fabric_revision,
                "adapters":["nvidia.fabric.hermes"]}]
        });
        let load = |value: &serde_json::Value, release| {
            Capabilities::available()
                .with_release_pins(&serde_json::to_vec(value).unwrap(), release)
        };
        let capabilities = load(&pins, Some("v0.1.0-rc.5")).unwrap();
        assert_eq!(capabilities.image_release(&reference), Some("v0.1.0-rc.5"));
        assert!(load(&pins, Some("v0.1.0")).is_err());
        for (path, value) in [
            (
                "/agentImages/0/reference",
                json!("ghcr.io/nvidia/nemoclaw/v1/hermes:latest"),
            ),
            ("/agentImages/0/fabricRevision", json!("f".repeat(40))),
            ("/components", json!({})),
            ("/agentImages/0/adapters", json!([])),
            ("/release", json!("v0.1.0/../../latest")),
        ] {
            let mut invalid = pins.clone();
            *invalid.pointer_mut(path).unwrap() = value;
            assert!(load(&invalid, None).is_err(), "must refuse {path}");
        }
        let mut unknown = pins;
        unknown["agentImages"][0]["adapters"] = json!(["unknown.adapter"]);
        assert_eq!(
            load(&unknown, None).unwrap().image_release(&reference),
            None
        );
    }
}
