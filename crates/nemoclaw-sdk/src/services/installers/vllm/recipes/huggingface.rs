// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pinned model identity and snapshot resolution.
use super::super::Service;
pub use crate::snapshot::MANIFEST_FILE;
use crate::{
    Error,
    snapshot::{Manifest, ModelManifest},
};
use sha2::{Digest, Sha256};
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
    if let Some(expected) = service
        .recipe
        .as_ref()
        .and_then(|recipe| recipe.snapshot.as_ref())
        && manifest != expected
    {
        return Err(Error::Conflict(
            "snapshot manifest conflicts with recipe snapshot",
        ));
    }
    crate::services::installers::vllm::validation::validate_weights(service, manifest)
}
pub fn decode_manifest(service: &Service, bytes: &[u8]) -> Result<ModelManifest, Error> {
    let manifest = ModelManifest::decode(bytes)?;
    validate_manifest(service, &manifest.snapshot())?;
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
