// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Verify image-owned metadata without contacting a registry or container engine.
use crate::{
    ObservationError, Secrets,
    discovery::{FabricObservation, ObservationStatus},
    fabric_capabilities::ImageMetadata,
    fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL},
};
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

/// Verify declared cluster runtime images before reconciling runtime resources.
pub fn verify_cluster_runtime_images(
    document: &crate::config::Document,
    secrets: &dyn Secrets,
) -> Result<(), ObservationError> {
    use crate::services::ServiceDefinition;
    use nemoclaw_runtime::RuntimeSpec;
    for service in document.spec.services.values() {
        let Some(settings) = service.kubernetes() else {
            continue;
        };
        let (image, architecture, runtime) = match service {
            ServiceDefinition::Vllm(service) => (
                service.image.as_str(),
                service.architecture().map_err(|_| invalid())?,
                RuntimeSpec::Vllm(Box::new(service.runtime.clone())),
            ),
            ServiceDefinition::Ollama(service) => (
                service.image.as_str(),
                service.architecture().map_err(|_| invalid())?,
                RuntimeSpec::Ollama(Box::new(service.runtime.clone())),
            ),
            ServiceDefinition::OllamaProxy(_) => return Err(invalid()),
        };
        observe_runtime(
            secrets,
            &settings.image_metadata.env,
            image,
            architecture,
            &runtime,
        )?;
    }
    Ok(())
}

/// Verify one service image using its explicitly referenced local metadata bundle.
pub fn observe_runtime(
    secrets: &dyn Secrets,
    name: &str,
    image: &str,
    architecture: &str,
    runtime: &nemoclaw_runtime::RuntimeSpec,
) -> Result<(), ObservationError> {
    let verified = read_bundle(secrets, name).and_then(|bytes| verify_config(&bytes, image, Some(architecture)))
        .map_err(|_| ObservationError::Backend("runtime image metadata is missing, invalid, or does not match the immutable image; export its metadata bundle and set the imageMetadata environment reference"))?;
    let (backend, mut required) = match runtime {
        nemoclaw_runtime::RuntimeSpec::Vllm(service) => {
            let mut labels = service
                .recipe
                .as_ref()
                .map(|recipe| recipe.compatibility.image_labels.clone())
                .unwrap_or_default();
            if service.authentication.is_some() {
                labels.insert(
                    "org.nemoclaw.inference.authentication".into(),
                    "bearer-v1".into(),
                );
            }
            ("vllm", labels)
        }
        nemoclaw_runtime::RuntimeSpec::Ollama(_) => ("ollama", BTreeMap::new()),
    };
    // Mandatory labels override recipe declarations, matching the Docker installer.
    required.insert(
        nemoclaw_runtime::SPEC_VERSION_LABEL.into(),
        nemoclaw_runtime::SPEC_VERSION.into(),
    );
    required.insert("org.nemoclaw.backend".into(), backend.into());
    let labels = &verified.config["config"]["Labels"];
    if verified.architecture != architecture
        || required
            .iter()
            .any(|(key, value)| labels[key].as_str() != Some(value.as_str()))
    {
        return Err(ObservationError::Backend(
            "runtime image platform or required runtime, backend, recipe, or authentication labels are incompatible; rebuild the runtime image and update its digest and metadata bundle",
        ));
    }
    Ok(())
}

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

struct VerifiedConfig {
    digest: String,
    architecture: String,
    config: Value,
}

/// Validate the reference-to-config digest chain before interpreting image labels.
/// Without an explicit architecture, the index must contain exactly one Linux platform.
/// No layer, URL, path, or remote reference is read.
fn verify_config(
    bytes: &[u8],
    image: &str,
    required_architecture: Option<&str>,
) -> Result<VerifiedConfig, ObservationError> {
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
        // Fabric sandboxes do not pin a scheduler architecture. Cluster model
        // services do, so their index may contain other Linux architectures.
        if required_architecture.is_none()
            && candidates
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
        || required_architecture.is_some_and(|required| required != architecture)
        || selected_platform.as_ref().is_some_and(|platform| {
            platform["architecture"] != architecture || platform["os"] != config["os"]
        })
    {
        return Err(invalid());
    }
    Ok(VerifiedConfig {
        digest: selected["config"]["digest"]
            .as_str()
            .ok_or_else(invalid)?
            .into(),
        architecture: architecture.into(),
        config,
    })
}

/// Validate the reference-to-config digest chain and the image's Fabric catalog.
pub fn verify(bytes: &[u8], image: &str) -> Result<FabricObservation, ObservationError> {
    let verified = verify_config(bytes, image, None)?;
    let catalog = FabricCatalog::from_json(
        verified.config["config"]["Labels"][IMAGE_CATALOG_LABEL]
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
        image_id: Some(verified.digest),
        catalog: Some(catalog),
        image: ImageMetadata {
            architecture: Some(verified.architecture),
            operating_system: Some("linux".into()),
            repo_digests: vec![image.into()],
            size_bytes: None,
        },
        compatibility: None,
    })
}

/// Read the explicitly referenced local bundle, without reporting its path or contents.
fn read_bundle(secrets: &dyn Secrets, name: &str) -> Result<Vec<u8>, ObservationError> {
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
    Ok(bytes)
}

/// Read the explicitly referenced local bundle, without reporting its path or contents.
pub fn observe(secrets: &dyn Secrets, name: &str, image: &str) -> FabricObservation {
    read_bundle(secrets, name)
        .and_then(|bytes| verify(&bytes, image))
        .unwrap_or_else(|_| FabricObservation {
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
