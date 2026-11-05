// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod hub;
mod manifest;
pub use manifest::{MANIFEST_FILE, ModelFile, ModelManifest};
#[cfg(test)]
mod tests;

use crate::{Error, files::save_json};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// One immutable file in a model snapshot.
pub struct File {
    /// Relative file path. Traversal and reserved NemoClaw metadata names are rejected.
    pub name: String,
    /// Expected file length in bytes; zero is rejected.
    pub size: u64,
    /// Lowercase SHA-256 of the complete file.
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Pinned model snapshot inventory. The parser rejects duplicate files and file/directory conflicts.
pub struct Manifest {
    /// Repository identity, which must match service.model.repository when used in a recipe.
    pub repository: String,
    /// Immutable commit, which must match service.model.revision when used in a recipe.
    pub revision: String,
    /// Nonempty inventory of pinned model files.
    pub files: Vec<File>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedFile {
    #[serde(flatten)]
    pub file: File,
    pub modified: u64,
}
fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
fn failure(message: &'static str) -> Error {
    Error::State(message)
}
impl Manifest {
    pub fn validate(&self) -> Result<(), Error> {
        if !regex::Regex::new(r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$")
            .unwrap()
            .is_match(&self.repository)
            || self
                .repository
                .split('/')
                .any(|part| part == "." || part == "..")
            || !regex::Regex::new(r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$")
                .unwrap()
                .is_match(&self.revision)
            || self.files.is_empty()
        {
            return Err(failure("model manifest lacks immutable identity"));
        }
        let mut seen = BTreeSet::new();
        let mut size = 0_u64;
        let sha256 = regex::Regex::new(r"^[a-f0-9]{64}$").unwrap();
        for file in &self.files {
            if file.name.is_empty()
                || file.name.contains(['\\', '\0'])
                || file.name.split('/').any(|part| {
                    part.is_empty()
                        || part == "."
                        || part == ".."
                        || part.starts_with(".nemoclaw")
                        || part.contains(".nemoclaw-")
                })
                || Path::new(&file.name)
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
                || file.size == 0
                || !sha256.is_match(&file.sha256)
                || !seen.insert(&file.name)
            {
                return Err(failure("model manifest has invalid or duplicate files"));
            }
            size = size
                .checked_add(file.size)
                .ok_or(failure("model snapshot size overflow"))?;
        }
        for name in &seen {
            if seen
                .iter()
                .any(|other| other.starts_with(&format!("{name}/")))
            {
                return Err(failure("model file conflicts with a directory"));
            }
        }
        Ok(())
    }
    pub fn key(&self) -> String {
        hex(Sha256::digest(
            serde_json::to_vec(self).expect("manifest serialization"),
        ))
    }
    pub fn bytes(&self) -> Result<u64, Error> {
        self.validate()?;
        Ok(self.files.iter().map(|file| file.size).sum())
    }
}
pub fn modified(path: &Path, size: u64) -> Result<u64, Error> {
    let metadata = fs::symlink_metadata(path).map_err(|_| failure("snapshot file unavailable"))?;
    if !metadata.is_file() || metadata.len() != size {
        return Err(failure("snapshot file changed or is incomplete"));
    }
    let nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    nanos
        .and_then(|n| u64::try_from(n).ok())
        .ok_or(failure("snapshot modification time is unavailable"))
}
// Every ancestor must be a real directory. Observation never follows a
// symlink outside persistent storage or creates a missing directory.
fn safe_path(root: &Path, relative: &str, create: bool) -> Result<PathBuf, Error> {
    let mut directory = root.to_path_buf();
    if create {
        fs::create_dir_all(&directory).map_err(|_| failure("cannot create snapshot directory"))?;
    }
    if !fs::symlink_metadata(&directory).is_ok_and(|m| m.is_dir()) {
        return Err(failure("snapshot root is not a directory"));
    }
    let mut parts = relative.split('/');
    let file = parts.next_back().unwrap_or(relative);
    for part in parts {
        directory.push(part);
        if create && !directory.exists() {
            fs::create_dir(&directory).map_err(|_| failure("cannot create snapshot directory"))?;
        }
        if !fs::symlink_metadata(&directory).is_ok_and(|m| m.is_dir()) {
            return Err(failure("snapshot ancestor is not a directory"));
        }
    }
    Ok(directory.join(file))
}
/// Record a snapshot another client downloaded. Every manifest file must be a
/// regular file of its listed size; its modification time then marks it verified.
pub fn record(directory: &Path, manifest: &Manifest) -> Result<ModelManifest, Error> {
    manifest.validate()?;
    let mut local = ModelManifest::new(manifest);
    for entry in &mut local.files {
        let path = safe_path(directory, &entry.file.name, false)?;
        entry.modified = Some(modified(&path, entry.file.size)?);
    }
    save_json(&safe_path(directory, MANIFEST_FILE, false)?, &local)?;
    Ok(local)
}

pub fn observe(directory: &Path, manifest: &Manifest) -> Result<ModelManifest, Error> {
    let local = ModelManifest::read(directory)?.ok_or(failure("model manifest unavailable"))?;
    local.validate_for(manifest)?;
    for verified in local.verified_files()? {
        check_verified(directory, &verified.file, verified.modified)?;
    }
    Ok(local)
}
fn check_verified(directory: &Path, file: &File, expected_modified: u64) -> Result<(), Error> {
    let path = safe_path(directory, &file.name, false)?;
    if modified(&path, file.size)? != expected_modified {
        return Err(failure(
            "verified model file changed; retained for inspection",
        ));
    }
    Ok(())
}

pub struct Client {
    base_url: String,
    http: reqwest::Client,
}
impl Client {
    pub fn new() -> Result<Self, Error> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(60))
            .read_timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(30))
            .no_gzip()
            .no_brotli()
            .no_zstd()
            .no_deflate()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 || attempt.url().scheme() != "https" {
                    attempt.error("model redirect rejected")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| failure("cannot initialize model transport"))?;
        Ok(Self {
            base_url: "https://huggingface.co".into(),
            http,
        })
    }
}
/// Create only real directories under the owned storage root.
pub fn directory(root: &Path, relative: &str) -> Result<PathBuf, Error> {
    let manifest = Manifest {
        repository: "internal/model".into(),
        revision: "0".repeat(40),
        files: vec![File {
            name: format!("{relative}/marker"),
            size: 1,
            sha256: "0".repeat(64),
        }],
    };
    manifest.validate()?;
    let path = safe_path(root, &manifest.files[0].name, true)?;
    Ok(path
        .parent()
        .ok_or(failure("invalid model directory"))?
        .to_path_buf())
}
