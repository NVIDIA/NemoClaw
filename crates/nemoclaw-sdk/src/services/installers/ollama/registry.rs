// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Ollama registry metadata and native cache layout.

use crate::{
    Error,
    snapshot::{Client, File, Manifest},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryManifest {
    schema_version: u32,
    media_type: String,
    config: Layer,
    layers: Vec<Layer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layer {
    media_type: String,
    digest: String,
    size: u64,
}

fn failure(message: &'static str) -> Error {
    Error::State(message)
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn identity(name: &str, digest: &str) -> Result<(String, String), Error> {
    if !regex::Regex::new(super::MODEL_PATTERN)
        .unwrap()
        .is_match(name)
        || !regex::Regex::new("^[a-f0-9]{64}$")
            .unwrap()
            .is_match(digest)
    {
        return Err(failure("invalid pinned Ollama model identity"));
    }
    let (model, tag) = name
        .split_once(':')
        .ok_or(failure("Ollama model tag is required"))?;
    Ok((format!("library/{model}"), tag.into()))
}

pub(crate) fn manifest_path(name: &str, digest: &str) -> Result<String, Error> {
    let (repository, tag) = identity(name, digest)?;
    Ok(format!("manifests/registry.ollama.ai/{repository}/{tag}"))
}

pub(crate) async fn resolve(client: &Client, name: &str, digest: &str) -> Result<Manifest, Error> {
    tokio::time::timeout(
        Duration::from_secs(120),
        resolve_inner(client, name, digest),
    )
    .await
    .map_err(|_| failure("registry resolution timed out"))?
}

async fn resolve_inner(client: &Client, name: &str, digest: &str) -> Result<Manifest, Error> {
    let (repository, tag) = identity(name, digest)?;
    let bytes = client.registry_manifest(&repository, &tag, 1 << 20).await?;
    let manifest = decode(name, digest, &bytes)?;
    for file in parameter_files(&bytes)? {
        let parameters = client.registry_file(&manifest, &file, 1 << 20).await?;
        if parameters.len() as u64 != file.size || hex(Sha256::digest(&parameters)) != file.sha256 {
            return Err(failure("Ollama parameters differ from the pinned manifest"));
        }
        validate_parameters(&parameters)?;
    }
    Ok(manifest)
}

pub(crate) fn parameter_files(bytes: &[u8]) -> Result<Vec<File>, Error> {
    let native: RegistryManifest = serde_json::from_slice(bytes)
        .map_err(|_| failure("incomplete Ollama registry manifest"))?;
    native
        .layers
        .into_iter()
        .filter(|layer| layer.media_type == "application/vnd.ollama.image.params")
        .map(|layer| {
            let digest = layer
                .digest
                .strip_prefix("sha256:")
                .ok_or(failure("invalid parameter layer digest"))?;
            if layer.size > 1 << 20 {
                return Err(failure("Ollama parameter layer exceeds metadata limit"));
            }
            Ok(File {
                name: format!("blobs/sha256-{digest}"),
                size: layer.size,
                sha256: digest.into(),
            })
        })
        .collect()
}

pub(crate) fn validate_parameters(bytes: &[u8]) -> Result<(), Error> {
    let parameters: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(bytes).map_err(|_| failure("incomplete Ollama model parameters"))?;
    if parameters.keys().any(|key| {
        ![
            "num_keep",
            "seed",
            "num_predict",
            "top_k",
            "top_p",
            "min_p",
            "typical_p",
            "temperature",
            "repeat_last_n",
            "repeat_penalty",
            "presence_penalty",
            "frequency_penalty",
            "stop",
        ]
        .contains(&key.as_str())
    }) {
        return Err(Error::Conflict(
            "Ollama model parameters contain unsupported runner or resource overrides",
        ));
    }
    Ok(())
}

pub(crate) fn decode(name: &str, digest: &str, bytes: &[u8]) -> Result<Manifest, Error> {
    let (repository, _) = identity(name, digest)?;
    if bytes.len() > 1 << 20 || hex(Sha256::digest(bytes)) != digest {
        return Err(Error::Conflict(
            "Ollama tag differs from the pinned manifest digest",
        ));
    }
    let native: RegistryManifest = serde_json::from_slice(bytes)
        .map_err(|_| failure("incomplete Ollama registry manifest"))?;
    if native.schema_version != 2
        || native.media_type != "application/vnd.docker.distribution.manifest.v2+json"
        || native.config.media_type != "application/vnd.docker.container.image.v1+json"
        || native.layers.is_empty()
        || native.layers.len() > 100
        || native
            .layers
            .iter()
            .filter(|layer| layer.media_type == "application/vnd.ollama.image.model")
            .count()
            != 1
        || native.layers.iter().any(|layer| {
            !["model", "template", "license", "params", "system"]
                .iter()
                .any(|kind| layer.media_type == format!("application/vnd.ollama.image.{kind}"))
        })
    {
        return Err(failure("unsupported Ollama registry model format"));
    }
    let mut files = vec![File {
        name: manifest_path(name, digest)?,
        size: bytes.len() as u64,
        sha256: digest.into(),
    }];
    for layer in std::iter::once(native.config).chain(native.layers) {
        let sha256 = layer
            .digest
            .strip_prefix("sha256:")
            .ok_or(failure("registry layer has no SHA-256 identity"))?;
        files.push(File {
            name: format!("blobs/sha256-{sha256}"),
            sha256: sha256.into(),
            size: layer.size,
        });
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    let manifest = Manifest {
        repository,
        revision: digest.into(),
        files,
    };
    manifest.validate()?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn native() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
            "config": {"mediaType":"application/vnd.docker.container.image.v1+json","digest":format!("sha256:{}",hex(Sha256::digest(b"{}"))),"size":2},
            "layers": [{"mediaType":"application/vnd.ollama.image.model","digest":format!("sha256:{}",hex(Sha256::digest(b"GGUF"))),"size":4}]
        }))
        .unwrap()
    }

    #[test]
    fn digest_and_media_types_are_pinned() {
        let bytes = native();
        let digest = hex(Sha256::digest(&bytes));
        decode("test:tiny", &digest, &bytes).unwrap();
        assert!(decode("test:tiny", &"a".repeat(64), &bytes).is_err());
        let mut changed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        changed["layers"][0]["mediaType"] = json!("application/vnd.ollama.image.adapter");
        let changed = serde_json::to_vec(&changed).unwrap();
        assert!(decode("test:tiny", &hex(Sha256::digest(&changed)), &changed).is_err());
    }

    #[test]
    fn parameters_cannot_override_resources() {
        validate_parameters(br#"{"temperature":0.6,"top_k":20}"#).unwrap();
        for field in ["num_ctx", "num_gpu", "num_batch", "num_thread", "use_mlock"] {
            assert!(validate_parameters(format!("{{\"{field}\":1}}").as_bytes()).is_err());
        }
    }
}
