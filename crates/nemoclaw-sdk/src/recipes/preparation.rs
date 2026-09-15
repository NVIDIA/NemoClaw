// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Generic preparation protocol and durable completion receipts.
use super::inline::{InlineRecipe, relative};
use crate::{
    CancellationToken, Error,
    config::Service,
    snapshot::{File, VerifiedFile},
    state::save_json,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path};

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
pub struct Completion {
    pub key: String,
    pub files: Vec<VerifiedFile>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verification {
    pub files: Vec<File>,
}
fn invalid() -> Error {
    Error::State("recipe preparation evidence is incomplete or changed")
}
pub fn validate_receipt(
    recipe: &InlineRecipe,
    key: &str,
    receipt: &Completion,
) -> Result<(), Error> {
    if receipt.key != key || receipt.files.is_empty() || receipt.files.len() > 1024 {
        return Err(invalid());
    }
    let mut names = BTreeSet::new();
    let mut total = 0u64;
    for file in &receipt.files {
        let f = &file.file;
        if !relative(&f.name)
            || f.name == "complete.json"
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
fn observe(root: &Path, recipe: &InlineRecipe, key: &str) -> Result<Completion, Error> {
    if !fs::symlink_metadata(root).is_ok_and(|m| m.is_dir()) {
        return Err(invalid());
    }
    let marker = root.join("complete.json");
    if !fs::symlink_metadata(&marker).is_ok_and(|m| m.is_file() && m.len() <= 1 << 20) {
        return Err(invalid());
    }
    let receipt: Completion =
        serde_json::from_slice(&fs::read(marker).map_err(|_| invalid())?).map_err(|_| invalid())?;
    validate_receipt(recipe, key, &receipt)?;
    for file in &receipt.files {
        check_path(root, &file.file.name)?;
        if crate::snapshot::modified(&root.join(&file.file.name), file.file.size)? != file.modified
        {
            return Err(invalid());
        }
    }
    Ok(receipt)
}
fn check_path(root: &Path, name: &str) -> Result<(), Error> {
    if !relative(name) {
        return Err(invalid());
    }
    let mut path = root.to_path_buf();
    let parts: Vec<_> = name.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        path.push(part);
        let m = fs::symlink_metadata(&path).map_err(|_| invalid())?;
        if (i + 1 == parts.len() && !m.is_file()) || (i + 1 < parts.len() && !m.is_dir()) {
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
) -> Result<Completion, Error> {
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
        let evidence: Verification = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        let mut receipt = Completion {
            key: key.clone(),
            files: Vec::new(),
        };
        for file in evidence.files {
            check_path(&staging, &file.name)?;
            let path = staging.join(&file.name);
            let modified = crate::snapshot::modified(&path, file.size)?;
            // The verifier declares semantic correctness; the supervisor independently
            // verifies the byte digest before recording the receipt.
            if crate::bundle::hash_file(&path)? != file.sha256 {
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
            receipt.files.push(VerifiedFile { file, modified });
        }
        validate_receipt(recipe, &key, &receipt)?;
        save_json(&staging.join("complete.json"), &receipt)?;
        fs::rename(&staging, &directory).map_err(|_| invalid())?;
        #[cfg(unix)]
        fs::File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| invalid())?;
        observe(&directory, recipe, &key)
    };
    tokio::select! { ()=cancel.cancelled()=>Err(Error::Cancelled), result=work=>result }
}
