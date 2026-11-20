// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::GgufModel;
use crate::{CancellationToken, Error};
use std::path::{Path, PathBuf};

#[cfg(all(feature = "execution", target_os = "linux"))]
pub(crate) async fn prepare(
    root: &Path,
    model: &GgufModel,
    cancel: &CancellationToken,
) -> Result<PathBuf, Error> {
    prepare_from(root, model, "https://huggingface.co", cancel).await
}
async fn prepare_from(
    root: &Path,
    model: &GgufModel,
    origin: &str,
    cancel: &CancellationToken,
) -> Result<PathBuf, Error> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    model.manifest().validate()?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let directory = crate::snapshot::directory(root, &format!("gguf/{}", model.manifest().key()))?;
    let path = directory.join("model.gguf");
    let mut cached = model.manifest();
    cached.files[0].name = "model.gguf".into();
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() != model.size_bytes {
                return Err(Error::Conflict(
                    "cached GGUF changed; retained for inspection",
                ));
            }
            if crate::snapshot::ModelManifest::read(&directory)?.is_some() {
                crate::snapshot::observe(&directory, &cached)?;
                return Ok(path);
            }
            // Upgrade retained caches once; new acquisitions are verified while streaming.
            let owned = path.clone();
            let hash = tokio::select! {
                () = cancel.cancelled() => return Err(Error::Cancelled),
                hash = tokio::task::spawn_blocking(move || crate::files::hash_file(&owned)) => hash.map_err(|_| Error::State("GGUF verification task failed"))??,
            };
            if hash != model.sha256 {
                return Err(Error::Conflict(
                    "cached GGUF checksum differs; retained for inspection",
                ));
            }
            crate::snapshot::record(&directory, &cached)?;
            return Ok(path);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::State("GGUF cache is unobservable")),
    }
    let work = async {
        let mut response = crate::snapshot::Client::at(origin)?
            .download(&model.repository, &model.revision, &model.file)
            .await?;
        if response
            .content_length()
            .is_some_and(|n| n != model.size_bytes)
        {
            return Err(Error::State("GGUF response rejected or length differs"));
        }
        let staged = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|_| Error::State("cannot stage GGUF"))?;
        let mut writer = tokio::fs::File::from_std(
            staged
                .reopen()
                .map_err(|_| Error::State("cannot open staged GGUF"))?,
        );
        let mut size = 0_u64;
        let mut hash = Sha256::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::State("GGUF transfer interrupted"))?
        {
            size = size
                .checked_add(chunk.len() as u64)
                .ok_or(Error::State("GGUF size overflow"))?;
            if size > model.size_bytes {
                return Err(Error::Conflict("GGUF exceeds its pinned size"));
            }
            hash.update(&chunk);
            writer
                .write_all(&chunk)
                .await
                .map_err(|_| Error::State("cannot write staged GGUF"))?;
        }
        let hash: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if size != model.size_bytes || hash != model.sha256 {
            return Err(Error::Conflict(
                "GGUF size or checksum differs from its immutable identity",
            ));
        }
        writer
            .sync_all()
            .await
            .map_err(|_| Error::State("cannot sync GGUF"))?;
        drop(writer);
        staged
            .persist_noclobber(&path)
            .map_err(|_| Error::State("cannot commit verified GGUF"))?;
        #[cfg(unix)]
        std::fs::File::open(&directory)
            .and_then(|d| d.sync_all())
            .map_err(|_| Error::State("cannot sync GGUF directory"))?;
        crate::snapshot::record(&directory, &cached)?;
        Ok(path)
    };
    tokio::select! {
        () = cancel.cancelled() => Err(Error::Cancelled),
        result = tokio::time::timeout(std::time::Duration::from_secs(8 * 3600), work) => result.map_err(|_| Error::State("GGUF acquisition exceeded budget"))?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    fn model(bytes: &[u8]) -> GgufModel {
        GgufModel {
            repository: "owner/model".into(),
            revision: "a".repeat(40),
            file: "nested/model.gguf".into(),
            size_bytes: bytes.len() as u64,
            sha256: Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
        }
    }
    #[tokio::test]
    async fn acquisition_publishes_verified_bytes_and_warm_start_never_downloads() {
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        let server = crate::http_fixture::Fixture::start_tcp(move |request| {
            assert_eq!(
                request.path,
                format!("/owner/model/resolve/{}/nested/model.gguf", "a".repeat(40))
            );
            count.fetch_add(1, Ordering::SeqCst);
            Some((200, b"GGUF model".to_vec()))
        })
        .await;
        let root = tempfile::tempdir().unwrap();
        let m = model(b"GGUF model");
        let cancel = CancellationToken::new();
        let path = prepare_from(root.path(), &m, &server.endpoint, &cancel)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"GGUF model");
        assert_eq!(
            prepare_from(root.path(), &m, &server.endpoint, &cancel)
                .await
                .unwrap(),
            path
        );
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        std::fs::write(&path, b"evil model").unwrap();
        assert!(
            prepare_from(root.path(), &m, &server.endpoint, &cancel)
                .await
                .is_err()
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "tampered cache is retained for inspection"
        );
    }
    #[tokio::test]
    #[cfg(unix)]
    async fn warm_start_observes_verified_metadata_without_reading_weights() {
        use std::os::unix::fs::PermissionsExt;
        let server =
            crate::http_fixture::Fixture::start_tcp(|_| Some((200, b"GGUF".to_vec()))).await;
        let root = tempfile::tempdir().unwrap();
        let model = model(b"GGUF");
        let cancel = CancellationToken::new();
        let path = prepare_from(root.path(), &model, &server.endpoint, &cancel)
            .await
            .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let observed = prepare_from(root.path(), &model, &server.endpoint, &cancel).await;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(observed.unwrap(), path);
    }
    #[tokio::test]
    async fn wrong_hash_or_length_never_commits_and_retry_can_succeed() {
        let hits = Arc::new(AtomicUsize::new(0));
        let count = hits.clone();
        let server = crate::http_fixture::Fixture::start_tcp(move |_| {
            Some((
                200,
                match count.fetch_add(1, Ordering::SeqCst) {
                    0 => b"bad".to_vec(),
                    1 => b"bad!".to_vec(),
                    _ => b"GGUF".to_vec(),
                },
            ))
        })
        .await;
        let root = tempfile::tempdir().unwrap();
        let m = model(b"GGUF");
        let cancel = CancellationToken::new();
        for _ in 0..2 {
            assert!(
                prepare_from(root.path(), &m, &server.endpoint, &cancel)
                    .await
                    .is_err()
            );
        }
        let path = prepare_from(root.path(), &m, &server.endpoint, &cancel)
            .await
            .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), b"GGUF");
    }
}
