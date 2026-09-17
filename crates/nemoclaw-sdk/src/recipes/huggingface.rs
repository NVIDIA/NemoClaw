// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pinned model identity and snapshot resolution.
use crate::{
    Error,
    config::{ConfigError, Service, constraints as c},
    snapshot::Manifest,
};
use sha2::{Digest, Sha256};
pub const MANIFEST_FILE: &str = ".nemoclaw-manifest.json";
pub fn directory(service: &Service) -> String {
    if let Some(reuse) = service.recipe.as_ref().and_then(|r| r.reuse.as_ref()) {
        return reuse.snapshot_directory.clone();
    }
    let hash = Sha256::digest(format!(
        "{}\0{}",
        service.model.repository, service.model.revision
    ));
    format!(
        "models/{}",
        hash.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
pub(crate) fn validate_model(service: &Service) -> Result<(), ConfigError> {
    let repository = &service.model.repository;
    if !regex::Regex::new(c::REPOSITORY)
        .unwrap()
        .is_match(repository)
        || repository.len() > 200
        || !regex::Regex::new(c::REVISION)
            .unwrap()
            .is_match(&service.model.revision)
    {
        return Err(ConfigError::new(
            "model requires a repository and immutable commit revision",
        ));
    }
    Ok(())
}
pub fn validate_manifest(service: &Service, manifest: &Manifest) -> Result<(), Error> {
    service.validate()?;
    manifest.validate()?;
    if manifest.repository != service.model.repository
        || manifest.revision != service.model.revision
    {
        return Err(Error::Conflict(
            "snapshot manifest conflicts with selected model",
        ));
    }
    crate::backends::validation::validate_weights(service, manifest)
}
pub fn decode_manifest(service: &Service, bytes: &[u8]) -> Result<Manifest, Error> {
    let manifest: Manifest = serde_json::from_slice(bytes)
        .map_err(|_| Error::State("invalid retained model manifest"))?;
    validate_manifest(service, &manifest)?;
    Ok(manifest)
}
pub async fn resolve_manifest(service: &Service) -> Result<Manifest, Error> {
    if let Some(manifest) = service.recipe.as_ref().and_then(|r| r.snapshot.as_ref()) {
        validate_manifest(service, manifest)?;
        return Ok(manifest.clone());
    }
    let manifest = crate::snapshot::Client::new()?
        .resolve(&service.model.repository, &service.model.revision)
        .await?;
    validate_manifest(service, &manifest)?;
    Ok(manifest)
}
