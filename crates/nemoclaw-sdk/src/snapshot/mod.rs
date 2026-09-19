// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod hub;
mod manifest;
pub use manifest::{MANIFEST_FILE, ModelFile, ModelManifest};
#[cfg(test)]
mod tests;

use crate::{CancellationToken, Error, state::save_json};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

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
pub(crate) fn modified(path: &Path, size: u64) -> Result<u64, Error> {
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
    registry: bool,
    http: reqwest::Client,
    resume_attempts: usize,
}
enum AttemptFailure {
    Interrupted,
    Other(Error),
}
impl From<Error> for AttemptFailure {
    fn from(error: Error) -> Self {
        Self::Other(error)
    }
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
            registry: false,
            http,
            resume_attempts: 4,
        })
    }
    /// An OCI-style registry adapter uses the same checksummed, resumable file lifecycle.
    pub(crate) fn registry(origin: &str) -> Result<Self, Error> {
        let mut client = Self::new()?;
        let url = reqwest::Url::parse(origin).map_err(|_| failure("invalid registry origin"))?;
        if url.scheme() != "https" || url.host_str().is_none() || url.path() != "/" {
            return Err(failure("invalid registry origin"));
        }
        client.base_url = origin.trim_end_matches('/').into();
        client.registry = true;
        Ok(client)
    }
    fn file_url(&self, manifest: &Manifest, file: &File) -> Result<reqwest::Url, Error> {
        if self.registry {
            manifest.validate()?;
            let mut url = reqwest::Url::parse(&self.base_url)
                .map_err(|_| failure("invalid registry origin"))?;
            let mut path = url
                .path_segments_mut()
                .map_err(|_| failure("invalid registry origin"))?;
            path.push("v2").extend(manifest.repository.split('/'));
            if file.name == format!("blobs/sha256-{}", file.sha256) {
                path.extend(["blobs", &format!("sha256:{}", file.sha256)]);
            } else if file.sha256 == manifest.revision {
                let reference = file
                    .name
                    .rsplit_once('/')
                    .map(|(_, reference)| reference)
                    .filter(|reference| !reference.is_empty())
                    .ok_or(failure("invalid registry manifest path"))?;
                path.extend(["manifests", reference]);
            } else {
                return Err(failure("invalid registry snapshot path"));
            }
            drop(path);
            return Ok(url);
        }
        let mut url =
            reqwest::Url::parse(&self.base_url).map_err(|_| failure("invalid model origin"))?;
        url.path_segments_mut()
            .map_err(|_| failure("invalid model origin"))?
            .extend(manifest.repository.split('/'))
            .push("resolve")
            .push(&manifest.revision)
            .extend(file.name.split('/'));
        Ok(url)
    }

    pub(crate) async fn registry_manifest(
        &self,
        repository: &str,
        reference: &str,
        limit: usize,
    ) -> Result<Vec<u8>, Error> {
        if !self.registry {
            return Err(failure("registry metadata requires a registry client"));
        }
        let mut url =
            reqwest::Url::parse(&self.base_url).map_err(|_| failure("invalid registry origin"))?;
        url.path_segments_mut()
            .map_err(|_| failure("invalid registry origin"))?
            .push("v2")
            .extend(repository.split('/'))
            .extend(["manifests", reference]);
        self.bounded(url, limit).await
    }

    pub(crate) async fn registry_file(
        &self,
        manifest: &Manifest,
        file: &File,
        limit: usize,
    ) -> Result<Vec<u8>, Error> {
        let url = self.file_url(manifest, file)?;
        self.bounded(url, limit).await
    }
    /// Only explicit apply calls ensure. Interrupted body streams get at most
    /// four attempts with 1/2/4 second delays. Other failures never retry.
    pub async fn ensure(
        &self,
        directory: &Path,
        manifest: &Manifest,
        cancel: &CancellationToken,
        progress: &(dyn Fn(&str) + Sync),
    ) -> Result<ModelManifest, Error> {
        manifest.validate()?;
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let saved = ModelManifest::read(directory)?;
        let is_new = saved.is_none();
        let mut local = saved.unwrap_or_else(|| ModelManifest::new(manifest));
        local.validate_for(manifest)?;
        // Check established files before starting any remaining downloads.
        for entry in &local.files {
            if let Some(modified) = entry.modified {
                check_verified(directory, &entry.file, modified)?;
            }
        }
        let pending: Vec<_> = local
            .files
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.modified.is_none())
            .map(|(index, _)| index)
            .collect();
        if pending.is_empty() {
            return Ok(local);
        }
        if is_new {
            if fs::symlink_metadata(directory.join(".nemoclaw-complete.json")).is_ok() {
                return Err(failure(
                    "unsupported legacy model metadata; retained for inspection",
                ));
            }
            let path = safe_path(directory, MANIFEST_FILE, true)?;
            save_json(&path, &local)?;
        }
        let work = futures_util::stream::iter(pending)
            .map(|index| async move {
                let file = &manifest.files[index];
                progress(&file.name);
                let mut result = Err(failure(
                    "model stream incomplete; partial download retained",
                ));
                for attempt in 0..self.resume_attempts.clamp(1, 4) {
                    if attempt > 0 {
                        progress(&format!("resuming {} (attempt {})", file.name, attempt + 1));
                        tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
                    }
                    match self.ensure_file(directory, manifest, file, cancel).await {
                        Ok(file) => {
                            result = Ok(file);
                            break;
                        }
                        Err(AttemptFailure::Other(error)) => {
                            result = Err(error);
                            break;
                        }
                        Err(AttemptFailure::Interrupted) => {}
                    }
                }
                (index, result)
            })
            .buffer_unordered(4);
        tokio::pin!(work);
        // One writer saves each completed file, including during a partial download.
        // Concurrent transfers never overwrite each other's manifest updates.
        while let Some((index, result)) = tokio::select! {
            () = cancel.cancelled() => return Err(Error::Cancelled),
            result = work.next() => result,
        } {
            local.files[index].modified = Some(result?.modified);
            save_json(&directory.join(MANIFEST_FILE), &local)?;
        }
        observe(directory, manifest)
    }
    async fn ensure_file(
        &self,
        directory: &Path,
        manifest: &Manifest,
        want: &File,
        cancel: &CancellationToken,
    ) -> Result<VerifiedFile, AttemptFailure> {
        let path = safe_path(directory, &want.name, true)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(failure("snapshot path is not a regular file").into());
                }
                let modified = verify(&path, want, cancel).await?;
                return Ok(VerifiedFile {
                    file: want.clone(),
                    modified,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(failure("cannot inspect snapshot file").into()),
        }
        let partial = path.with_file_name(format!(
            "{}.nemoclaw-partial",
            path.file_name().unwrap().to_string_lossy()
        ));
        match fs::symlink_metadata(&partial) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(failure("partial snapshot is not a regular file").into());
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(failure("cannot inspect partial snapshot").into());
            }
            _ => {}
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&partial)
            .await
            .map_err(|_| failure("cannot open partial snapshot"))?;
        let offset = file
            .metadata()
            .await
            .map_err(|_| failure("cannot inspect partial snapshot"))?
            .len();
        if offset > want.size {
            return Err(failure("partial snapshot exceeds pinned size").into());
        }
        if offset < want.size {
            let url = self.file_url(manifest, want)?;
            let mut request = self.http.get(url);
            if offset > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
            }
            let mut response = request
                .send()
                .await
                .map_err(|_| failure("model transport failed; partial download retained"))?;
            if offset == 0 && response.status() != reqwest::StatusCode::OK {
                return Err(failure("model request rejected").into());
            }
            if offset > 0
                && (response.status() != reqwest::StatusCode::PARTIAL_CONTENT
                    || response
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|h| h.to_str().ok())
                        != Some(&format!("bytes {offset}-{}/{}", want.size - 1, want.size)))
            {
                return Err(failure("model server did not confirm requested byte range").into());
            }
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|_| failure("cannot seek partial snapshot"))?;
            let mut size = offset;
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| AttemptFailure::Interrupted)?
            {
                if chunk.len() as u64 > want.size - size {
                    return Err(failure("model stream exceeded pinned size; data retained").into());
                }
                file.write_all(&chunk).await.map_err(|_| {
                    failure("model storage write failed; partial download retained")
                })?;
                // Complete Tokio's buffered write before accepting another chunk;
                // cancellation must leave the confirmed prefix resumable.
                file.flush()
                    .await
                    .map_err(|_| failure("model storage write failed"))?;
                size += chunk.len() as u64;
            }
            if size != want.size {
                return Err(AttemptFailure::Interrupted);
            }
            file.sync_all()
                .await
                .map_err(|_| failure("cannot sync model data"))?;
        }
        drop(file);
        let verified_modified = verify(&partial, want, cancel).await?;
        tokio::fs::rename(&partial, &path)
            .await
            .map_err(|_| failure("cannot commit verified model file"))?;
        #[cfg(unix)]
        fs::File::open(path.parent().ok_or(failure("invalid model file path"))?)
            .and_then(|parent| parent.sync_all())
            .map_err(|_| failure("cannot sync model file directory"))?;
        check_verified(directory, want, verified_modified)?;
        Ok(VerifiedFile {
            file: want.clone(),
            modified: verified_modified,
        })
    }
}
async fn verify(path: &Path, want: &File, cancel: &CancellationToken) -> Result<u64, Error> {
    let before = modified(path, want.size)?;
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.write(true);
    let mut file = options
        .open(path)
        .await
        .map_err(|_| failure("cannot verify model file"))?;
    let mut digest = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|_| failure("cannot read model verification data"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
        bytes += count as u64;
    }
    if bytes != want.size || hex(digest.finalize()) != want.sha256 {
        return Err(failure(
            "model file does not match pinned size and SHA-256; retained for inspection",
        ));
    }
    if modified(path, want.size)? != before {
        return Err(failure("model file changed during verification"));
    }
    file.sync_all()
        .await
        .map_err(|_| failure("cannot sync verified model file"))?;
    Ok(before)
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
