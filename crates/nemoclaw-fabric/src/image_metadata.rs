// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Verify image-owned metadata without contacting a registry or container engine.
use crate::{
    capabilities::{FabricObservation, ImageMetadata},
    catalog::{FabricCatalog, IMAGE_CATALOG_LABEL},
};
use nemoclaw_backend::{ObservationError, ObservationStatus, Secrets};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};

pub const MAX_BUNDLE_BYTES: usize = 8 * 1024 * 1024;
const SOURCE: &str = "verified_oci_metadata";
const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX: &str = "application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST: &str = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_CONFIG: &str = "application/vnd.oci.image.config.v1+json";
const DOCKER_CONFIG: &str = "application/vnd.docker.container.image.v1+json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    schema_version: u32,
    manifest_digest: String,
    /// Exact UTF-8 JSON bytes, encoded as JSON strings rather than reserialized objects.
    blobs: BTreeMap<String, String>,
}

fn invalid() -> ObservationError {
    ObservationError::Incomplete
}
fn digest_valid(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn sha256(raw: &[u8]) -> String {
    let hex: String = Sha256::digest(raw)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("sha256:{hex}")
}
fn blob<'a>(bundle: &'a Bundle, digest: &str) -> Result<&'a str, ObservationError> {
    let raw = bundle.blobs.get(digest).ok_or_else(invalid)?;
    if !digest_valid(digest) || sha256(raw.as_bytes()) != digest {
        return Err(invalid());
    }
    Ok(raw)
}
fn object(raw: &str) -> Result<Value, ObservationError> {
    let value: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
    if !value.is_object() {
        return Err(invalid());
    }
    Ok(value)
}
fn descriptor<'a>(bundle: &'a Bundle, value: &Value) -> Result<(&'a str, Value), ObservationError> {
    let digest = value["digest"].as_str().ok_or_else(invalid)?;
    let raw = blob(bundle, digest)?;
    if value["size"].as_u64() != Some(raw.len() as u64) {
        return Err(invalid());
    }
    Ok((raw, object(raw)?))
}
fn manifest(value: &Value) -> bool {
    value["schemaVersion"] == 2
        && matches!(
            value["mediaType"].as_str(),
            Some(OCI_MANIFEST | DOCKER_MANIFEST)
        )
        && value["layers"].is_array()
}

/// Validate the reference-to-config digest chain before interpreting its Fabric label.
/// Only one Linux platform is selected. No layer, URL, path, or remote reference is read.
pub fn verify(bytes: &[u8], image: &str) -> Result<FabricObservation, ObservationError> {
    if bytes.len() > MAX_BUNDLE_BYTES {
        return Err(invalid());
    }
    let (repository, root_digest) = image.rsplit_once('@').ok_or_else(invalid)?;
    if repository.is_empty()
        || !repository
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
        || !digest_valid(root_digest)
    {
        return Err(invalid());
    }
    let bundle: Bundle = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if bundle.schema_version != 1 || !(2..=3).contains(&bundle.blobs.len()) {
        return Err(invalid());
    }
    let root = object(blob(&bundle, root_digest)?)?;
    let selected = object(blob(&bundle, &bundle.manifest_digest)?)?;
    if !manifest(&selected) {
        return Err(invalid());
    }
    let indexed = root_digest != bundle.manifest_digest;
    let selected_platform = if indexed {
        if root["schemaVersion"] != 2
            || !matches!(root["mediaType"].as_str(), Some(OCI_INDEX | DOCKER_INDEX))
        {
            return Err(invalid());
        }
        let candidates = root["manifests"].as_array().ok_or_else(invalid)?;
        // The gateway receives the authored index reference. Until per-platform
        // runtime contracts are modeled, it must have only one Linux child.
        if candidates
            .iter()
            .filter(|entry| entry["platform"]["os"] == "linux")
            .count()
            != 1
        {
            return Err(invalid());
        }
        let matching: Vec<_> = candidates
            .iter()
            .filter(|entry| entry["digest"] == bundle.manifest_digest)
            .collect();
        let [entry] = matching.as_slice() else {
            return Err(invalid());
        };
        let (_, described) = descriptor(&bundle, entry)?;
        if entry["mediaType"] != described["mediaType"] {
            return Err(invalid());
        }
        let platform = &entry["platform"];
        if platform["os"] != "linux"
            || !matches!(platform["architecture"].as_str(), Some("amd64" | "arm64"))
            || candidates
                .iter()
                .filter(|candidate| {
                    candidate["platform"]["os"] == platform["os"]
                        && candidate["platform"]["architecture"] == platform["architecture"]
                })
                .count()
                != 1
        {
            return Err(invalid());
        }
        Some(platform.clone())
    } else {
        None
    };
    if bundle.blobs.len() != if indexed { 3 } else { 2 }
        || !matches!(
            selected["config"]["mediaType"].as_str(),
            Some(OCI_CONFIG | DOCKER_CONFIG)
        )
    {
        return Err(invalid());
    }
    let (_, config) = descriptor(&bundle, &selected["config"])?;
    let architecture = config["architecture"].as_str().ok_or_else(invalid)?;
    if config["os"] != "linux"
        || !matches!(architecture, "amd64" | "arm64")
        || selected_platform.as_ref().is_some_and(|platform| {
            platform["architecture"] != architecture || platform["os"] != config["os"]
        })
    {
        return Err(invalid());
    }
    let catalog = FabricCatalog::from_json(
        config["config"]["Labels"][IMAGE_CATALOG_LABEL]
            .as_str()
            .ok_or_else(invalid)?,
    )
    .map_err(|_| invalid())?;
    if catalog.runtime.is_none() {
        return Err(invalid());
    }
    Ok(FabricObservation {
        status: ObservationStatus::Available,
        reason: None,
        source: SOURCE.into(),
        image_id: selected["config"]["digest"].as_str().map(String::from),
        catalog: Some(catalog),
        image: ImageMetadata {
            architecture: Some(architecture.into()),
            operating_system: Some("linux".into()),
            repo_digests: vec![image.into()],
            size_bytes: None,
        },
        compatibility: None,
    })
}

/// Read the explicitly referenced local bundle, without reporting its path or contents.
pub fn observe(secrets: &dyn Secrets, name: &str, image: &str) -> FabricObservation {
    let read = || {
        let location = secrets.resolve(name)?;
        let path = Path::new(&location);
        if !path.is_absolute() || !path.is_file() {
            return Err(invalid());
        }
        let file = File::open(path).map_err(|_| invalid())?;
        if !file.metadata().map_err(|_| invalid())?.is_file() {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        file.take((MAX_BUNDLE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        verify(&bytes, image)
    };
    read().unwrap_or_else(|_| FabricObservation {
        status: ObservationStatus::Unknown,
        reason: Some(
            "image metadata bundle is missing, invalid, or does not match the immutable image"
                .into(),
        ),
        source: SOURCE.into(),
        image_id: None,
        catalog: None,
        image: ImageMetadata::default(),
        compatibility: None,
    })
}

#[cfg(test)]
mod tests;
