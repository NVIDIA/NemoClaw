// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Generic preparation protocol and verified output manifests.
use super::super::Service;
use super::inline::{InlineRecipe, relative};
use crate::{
    CancellationToken, Error,
    snapshot::{File, VerifiedFile},
    state::save_json,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

pub const MANIFEST_FILE: &str = "manifest.json";

#[derive(Clone, Copy, Debug)]
pub enum Action {
    Prepare,
    Verify,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request<'a> {
    pub api_version: &'static str,
    pub model_directory: &'a Path,
    pub output_directory: &'a Path,
    pub previous_directory: Option<&'a Path>,
}
#[async_trait::async_trait]
pub trait Runner: Send + Sync {
    async fn run(
        &self,
        action: Action,
        request: &Request<'_>,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error>;
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Preparation identity and verified file metadata saved in `manifest.json`.
pub struct OutputManifest {
    pub key: String,
    pub files: Vec<VerifiedFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verification {
    pub files: Vec<File>,
}
fn invalid() -> Error {
    Error::State("recipe preparation is incomplete or changed")
}
pub fn validate_manifest(
    recipe: &InlineRecipe,
    key: &str,
    output: &OutputManifest,
) -> Result<(), Error> {
    if output.key != key || output.files.is_empty() || output.files.len() > 1024 {
        return Err(invalid());
    }
    let mut names = BTreeSet::new();
    let mut total = 0u64;
    for file in &output.files {
        let f = &file.file;
        if !relative(&f.name)
            || f.name == MANIFEST_FILE
            || f.name.starts_with("manifest.json/")
            || !names.insert(&f.name)
            || f.size == 0
            || f.sha256.len() != 64
            || !f
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        total = total.checked_add(f.size).ok_or_else(invalid)?;
    }
    if total > recipe.resources.prepared_bytes {
        return Err(invalid());
    }
    Ok(())
}
fn observe(root: &Path, recipe: &InlineRecipe, key: &str) -> Result<OutputManifest, Error> {
    if !fs::symlink_metadata(root).is_ok_and(|m| m.is_dir()) {
        return Err(invalid());
    }
    let marker = root.join(MANIFEST_FILE);
    if !fs::symlink_metadata(&marker).is_ok_and(|m| m.is_file() && m.len() <= 1 << 20) {
        return Err(invalid());
    }
    let output: OutputManifest =
        serde_json::from_slice(&fs::read(marker).map_err(|_| invalid())?).map_err(|_| invalid())?;
    validate_manifest(recipe, key, &output)?;
    for file in &output.files {
        check_path(root, &file.file.name)?;
        if crate::snapshot::modified(&root.join(&file.file.name), file.file.size)? != file.modified
        {
            return Err(invalid());
        }
    }
    Ok(output)
}
fn check_path(root: &Path, name: &str) -> Result<(), Error> {
    if !relative(name) {
        return Err(invalid());
    }
    let mut path = root.to_path_buf();
    let mut parts = name.split('/').peekable();
    while let Some(part) = parts.next() {
        path.push(part);
        let m = fs::symlink_metadata(&path).map_err(|_| invalid())?;
        let expected_type = if parts.peek().is_none() {
            m.is_file()
        } else {
            m.is_dir()
        };
        if !expected_type {
            return Err(invalid());
        }
    }
    Ok(())
}
pub async fn prepare(
    root: &Path,
    model: &Path,
    service: &Service,
    runner: &dyn Runner,
    cancel: &CancellationToken,
) -> Result<OutputManifest, Error> {
    service.validate()?;
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let recipe = service.recipe.as_ref().ok_or_else(invalid)?;
    let key = recipe.key(service);
    let directory = root.join(&key);
    match fs::symlink_metadata(&directory) {
        Ok(_) => return observe(&directory, recipe, &key),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(invalid()),
    }
    let staging = crate::snapshot::directory(root, &format!("{key}.preparing"))?;
    let previous = recipe.reuse.as_ref().map(|r| root.join(&r.preparation_key));
    let request = Request {
        api_version: "nemoclaw.nvidia.com/recipe-execution/v1",
        model_directory: model,
        output_directory: &staging,
        previous_directory: previous.as_deref(),
    };
    let work = async {
        runner.run(Action::Prepare, &request, cancel).await?;
        let bytes = runner.run(Action::Verify, &request, cancel).await?;
        if bytes.len() > 1 << 20 {
            return Err(invalid());
        }
        let verification: Verification = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let mut output = OutputManifest {
            key: key.clone(),
            files: Vec::new(),
        };
        for file in verification.files {
            check_path(&staging, &file.name)?;
            let path = staging.join(&file.name);
            let modified = crate::snapshot::modified(&path, file.size)?;
            output.files.push(VerifiedFile { file, modified });
        }
        validate_manifest(recipe, &key, &output)?;
        for verified in &output.files {
            use sha2::{Digest, Sha256};
            use tokio::io::AsyncReadExt;
            let path = staging.join(&verified.file.name);
            let mut input = tokio::fs::File::open(&path).await.map_err(|_| invalid())?;
            let mut digest = Sha256::new();
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let length = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled), result=input.read(&mut buffer)=>result.map_err(|_|invalid())?};
                if length == 0 {
                    break;
                }
                digest.update(&buffer[..length]);
            }
            let digest: String = digest
                .finalize()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            if digest != verified.file.sha256
                || crate::snapshot::modified(&path, verified.file.size)? != verified.modified
            {
                return Err(invalid());
            }
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            options.write(true);
            options
                .open(&path)
                .and_then(|f| f.sync_all())
                .map_err(|_| invalid())?;
        }
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        save_json(&staging.join(MANIFEST_FILE), &output)?;
        fs::rename(&staging, &directory).map_err(|_| invalid())?;
        #[cfg(unix)]
        fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| invalid())?;
        observe(&directory, recipe, &key)
    };
    tokio::select! { ()=cancel.cancelled()=>Err(Error::Cancelled), result=work=>result }
}
