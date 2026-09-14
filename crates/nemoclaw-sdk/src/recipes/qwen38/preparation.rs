// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
#[path = "preparation_tests.rs"]
mod tests;

use super::{PREPARED_BYTES, PREPARED_FILE, hex, preparation_key};
use crate::{
    CancellationToken, Error,
    snapshot::{File, VerifiedFile},
    state::save_json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreparationAction {
    Prepare,
    Verify,
}
/// Implemented by the runtime's fixed packaged Python tools. This boundary is
/// injectable for failure tests; it is never a command or hook in configuration.
#[async_trait::async_trait]
pub trait PreparationRunner: Send + Sync {
    async fn run(
        &self,
        action: PreparationAction,
        model: &Path,
        directory: &Path,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error>;
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preparation {
    pub key: String,
    pub files: Vec<VerifiedFile>,
}
fn failure(message: &'static str) -> Error {
    Error::State(message)
}
fn regular(path: &Path) -> Result<fs::Metadata, Error> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| failure("packed PLE file is unobservable"))?;
    if !metadata.is_file() {
        return Err(failure("packed PLE path is not a regular file"));
    }
    Ok(metadata)
}
fn directory(path: &Path, create: bool) -> Result<(), Error> {
    if create {
        fs::create_dir_all(path).map_err(|_| failure("cannot create preparation directory"))?;
    }
    if !fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        return Err(failure("preparation path is not a directory"));
    }
    Ok(())
}
pub fn observe_preparation(path: &Path) -> Result<Preparation, Error> {
    directory(path, false)?;
    let marker = path.join("complete.json");
    if regular(&marker)?.len() > 1 << 20 {
        return Err(failure("packed PLE receipt exceeds limit"));
    }
    let bytes = fs::read(&marker).map_err(|_| failure("packed PLE receipt is unobservable"))?;
    let preparation: Preparation =
        serde_json::from_slice(&bytes).map_err(|_| failure("packed PLE receipt is invalid"))?;
    if preparation.key != preparation_key() || preparation.files.len() != 2 {
        return Err(failure(
            "packed PLE completion conflicts with pinned preparation",
        ));
    }
    for (verified, name) in preparation
        .files
        .iter()
        .zip([PREPARED_FILE.to_owned(), format!("{PREPARED_FILE}.json")])
    {
        if verified.file.name != name
            || verified.file.size == 0
            || verified.file.sha256.len() != 64
            || !verified
                .file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || crate::snapshot::modified(&path.join(name), verified.file.size)? != verified.modified
        {
            return Err(failure("verified packed PLE data changed"));
        }
    }
    Ok(preparation)
}
pub async fn prepare(
    root: &Path,
    model: &Path,
    runner: &dyn PreparationRunner,
    cancel: &CancellationToken,
) -> Result<Preparation, Error> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let destination = root.join(preparation_key());
    match fs::symlink_metadata(&destination) {
        Ok(_) => return observe_preparation(&destination),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            return Err(failure(
                "established preparation is unobservable; retained for inspection",
            ));
        }
    }
    directory(root, true)?;
    let staging = root.join(format!("{}.preparing", preparation_key()));
    directory(&staging, true)?;
    // Upstream skips a complete-length binary even if a crash prevented its
    // metadata rename. Only this unpublished orphan may be regenerated.
    match fs::symlink_metadata(staging.join(format!("{PREPARED_FILE}.json"))) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::remove_file(staging.join(PREPARED_FILE)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(failure("cannot remove unpublished packed PLE orphan")),
            }
        }
        Ok(metadata) if metadata.is_file() => {}
        _ => return Err(failure("staged packed PLE metadata is unobservable")),
    }
    let work = async {
        runner
            .run(PreparationAction::Prepare, model, &staging, cancel)
            .await?;
        let evidence = runner
            .run(PreparationAction::Verify, model, &staging, cancel)
            .await?;
        if evidence.len() > 1 << 20 {
            return Err(failure("packed PLE verifier evidence exceeds limit"));
        }
        let file: File = serde_json::from_slice(&evidence)
            .map_err(|_| failure("packed PLE verifier returned incomplete evidence"))?;
        if file.name != PREPARED_FILE
            || file.size == 0
            || file.size > PREPARED_BYTES
            || file.sha256.len() != 64
            || !file
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(failure("packed PLE verifier returned incomplete evidence"));
        }
        let metadata_name = format!("{PREPARED_FILE}.json");
        let metadata_path = staging.join(&metadata_name);
        let metadata = regular(&metadata_path)?;
        if metadata.len() == 0 || metadata.len() > 1 << 20 {
            return Err(failure("packed PLE metadata exceeds limit or is empty"));
        }
        let metadata_bytes =
            fs::read(&metadata_path).map_err(|_| failure("packed PLE metadata is unobservable"))?;
        let metadata_file = File {
            name: metadata_name,
            size: metadata_bytes.len() as u64,
            sha256: hex(Sha256::digest(&metadata_bytes)),
        };
        let mut prepared = Preparation {
            key: preparation_key(),
            files: Vec::new(),
        };
        for file in [file, metadata_file] {
            let path = staging.join(&file.name);
            let info = regular(&path)?;
            if info.len() != file.size {
                return Err(failure("prepared file changed during verification"));
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            // FlushFileBuffers requires write access on Windows, including for
            // data that the preparation tool already wrote and verified.
            #[cfg(windows)]
            options.write(true);
            options
                .open(&path)
                .and_then(|f| f.sync_all())
                .map_err(|_| failure("cannot sync prepared data"))?;
            let modified = crate::snapshot::modified(&path, file.size)?;
            prepared.files.push(VerifiedFile { file, modified });
        }
        save_json(&staging.join("complete.json"), &prepared)?;
        fs::rename(&staging, &destination)
            .map_err(|_| failure("cannot publish packed PLE preparation"))?;
        #[cfg(unix)]
        fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| failure("cannot sync prepared directory"))?;
        observe_preparation(&destination)
    };
    tokio::select! {()=cancel.cancelled()=>Err(Error::Cancelled),result=work=>result}
}
