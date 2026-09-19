// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Immutable Ollama registry snapshots owned by the Ollama installer.

use super::{ManagedOllama, registry};
use crate::{
    Error,
    snapshot::{self, Manifest, ModelManifest},
};
use sha2::{Digest, Sha256};

pub use snapshot::MANIFEST_FILE;

pub fn directory(service: &ManagedOllama) -> String {
    let hash = Sha256::digest(format!(
        "ollama\0{}\0{}",
        service.model.name, service.model.digest
    ));
    format!(
        "models/{}",
        hash.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

pub fn client(service: &ManagedOllama) -> Result<snapshot::Client, Error> {
    service.validate()?;
    snapshot::Client::registry("https://registry.ollama.ai")
}

pub fn validate_manifest(service: &ManagedOllama, manifest: &Manifest) -> Result<(), Error> {
    service.validate()?;
    manifest.validate()?;
    let (repository, _) = registry::identity(&service.model.name, &service.model.digest)?;
    let path = native_manifest_path(service)?;
    if manifest.repository != repository
        || manifest.revision != service.model.digest
        || manifest
            .files
            .iter()
            .filter(|file| file.name == path && file.sha256 == service.model.digest)
            .count()
            != 1
        || manifest
            .files
            .iter()
            .any(|file| file.name != path && file.name != format!("blobs/sha256-{}", file.sha256))
        || manifest.files.len() < 3
    {
        return Err(Error::Conflict(
            "snapshot manifest conflicts with selected Ollama model",
        ));
    }
    if service.memory.gpu_memory_utilization.is_none() {
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
    }
    Ok(())
}

pub fn decode_manifest(service: &ManagedOllama, bytes: &[u8]) -> Result<ModelManifest, Error> {
    let manifest = ModelManifest::decode(bytes)?;
    validate_manifest(service, &manifest.snapshot())?;
    Ok(manifest)
}

pub async fn resolve_manifest(service: &ManagedOllama) -> Result<Manifest, Error> {
    let client = client(service)?;
    let manifest = registry::resolve(&client, &service.model.name, &service.model.digest).await?;
    validate_manifest(service, &manifest)?;
    Ok(manifest)
}

pub fn native_manifest_path(service: &ManagedOllama) -> Result<String, Error> {
    registry::manifest_path(&service.model.name, &service.model.digest)
}

pub fn validate_native_manifest(
    service: &ManagedOllama,
    manifest: &Manifest,
    bytes: &[u8],
) -> Result<(), Error> {
    let expected = registry::decode(&service.model.name, &service.model.digest, bytes)?;
    if &expected != manifest {
        return Err(Error::Conflict(
            "Ollama native manifest differs from retained snapshot inventory",
        ));
    }
    validate_manifest(service, manifest)
}

pub fn validate_parameters(directory: &std::path::Path, native: &[u8]) -> Result<(), Error> {
    for file in registry::parameter_files(native)? {
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
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
                != file.sha256
        {
            return Err(Error::Conflict(
                "Ollama model parameters differ from their pinned identity",
            ));
        }
        registry::validate_parameters(&bytes)?;
    }
    Ok(())
}
