// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Model-source adapters. Capacity, retained downloads, and artifact observation
//! consume the same snapshot contract independently of the inference server.
use crate::{
    Error,
    config::Service,
    snapshot::{self, Manifest, ModelManifest},
};
use sha2::{Digest, Sha256};
pub use snapshot::MANIFEST_FILE;

pub fn directory(service: &Service) -> String {
    if service.backend != "ollama" {
        return crate::recipes::huggingface::directory(service);
    }
    let hash = Sha256::digest(format!(
        "ollama\0{}\0{}",
        service.model.name, service.model.digest
    ));
    format!(
        "models/{}",
        hash.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
pub fn client(service: &Service) -> Result<snapshot::Client, Error> {
    service.validate()?;
    if service.backend == "ollama" {
        snapshot::Client::ollama()
    } else {
        snapshot::Client::new()
    }
}
pub fn validate_manifest(service: &Service, manifest: &Manifest) -> Result<(), Error> {
    if service.backend != "ollama" {
        return crate::recipes::huggingface::validate_manifest(service, manifest);
    }
    service.validate()?;
    manifest.validate()?;
    let (repository, _) = snapshot::registry::identity(&service.model.name, &service.model.digest)?;
    let path = native_manifest_path(service)?;
    if manifest.repository != repository
        || manifest.revision != service.model.digest
        || manifest
            .files
            .iter()
            .filter(|f| f.name == path && f.sha256 == service.model.digest)
            .count()
            != 1
        || manifest
            .files
            .iter()
            .any(|f| f.name != path && f.name != format!("blobs/sha256-{}", f.sha256))
        || manifest.files.len() < 3
    {
        return Err(Error::Conflict(
            "snapshot manifest conflicts with selected Ollama model",
        ));
    }
    // This is a lower-bound check. Context, concurrency, native KV allocation,
    // and CPU offload are verified after a load-only request at startup.
    let budget = service.gpu_bytes()?;
    if manifest
        .bytes()?
        .checked_add(2 * crate::hardware::GIB)
        .is_none_or(|bytes| bytes > budget)
    {
        return Err(Error::Conflict(
            "Ollama model weights and runtime headroom exceed the declared memory budget",
        ));
    }
    Ok(())
}
pub fn decode_manifest(service: &Service, bytes: &[u8]) -> Result<ModelManifest, Error> {
    let manifest = ModelManifest::decode(bytes)?;
    validate_manifest(service, &manifest.snapshot())?;
    Ok(manifest)
}
pub async fn resolve_manifest(service: &Service) -> Result<Manifest, Error> {
    if service.backend != "ollama" {
        return crate::recipes::huggingface::resolve_manifest(service).await;
    }
    let manifest = client(service)?
        .resolve_ollama(&service.model.name, &service.model.digest)
        .await?;
    validate_manifest(service, &manifest)?;
    Ok(manifest)
}
pub fn native_manifest_path(service: &Service) -> Result<String, Error> {
    snapshot::registry::manifest_path(&service.model.name, &service.model.digest)
}
pub fn validate_native_manifest(
    service: &Service,
    manifest: &Manifest,
    bytes: &[u8],
) -> Result<(), Error> {
    let expected = snapshot::registry::decode(&service.model.name, &service.model.digest, bytes)?;
    if &expected != manifest {
        return Err(Error::Conflict(
            "Ollama native manifest differs from retained snapshot inventory",
        ));
    }
    validate_manifest(service, manifest)
}

/// Validate pinned native parameter blobs before starting the server. Resource
/// overrides in model defaults must not undo the selected context or GPU policy.
pub fn validate_ollama_parameters(directory: &std::path::Path, native: &[u8]) -> Result<(), Error> {
    for file in snapshot::registry::parameter_files(native)? {
        use std::io::Read;
        let source = std::fs::File::open(directory.join(&file.name))
            .map_err(|_| Error::State("Ollama model parameters are unobservable"))?;
        let mut bytes = Vec::new();
        source
            .take((1 << 20) + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::State("Ollama model parameters are unobservable"))?;
        if bytes.len() as u64 != file.size
            || Sha256::digest(&bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
                != file.sha256
        {
            return Err(Error::Conflict(
                "Ollama model parameters differ from their pinned identity",
            ));
        }
        snapshot::registry::validate_parameters(&bytes)?;
    }
    Ok(())
}
