// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::runtime::report;
use nemoclaw_sdk::{CancellationToken, Error, snapshot};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
pub(crate) struct PreparedModel {
    pub model: PathBuf,
    pub environment: std::collections::BTreeMap<String, std::ffi::OsString>,
}
pub(crate) async fn prepare(
    service: &nemoclaw_sdk::config::Service,
    root: &Path,
    cancel: &CancellationToken,
) -> Result<PreparedModel, Error> {
    use nemoclaw_sdk::recipes::huggingface as hf;
    if let Some(recipe) = &service.recipe {
        crate::inline_recipe::PackagedRecipe(recipe).validate_files()?;
    }

    let model = snapshot::directory(root, &hf::directory(service))?;
    let marker = model.join(hf::MANIFEST_FILE);
    let manifest = match std::fs::symlink_metadata(&marker) {
        Ok(meta) if meta.is_file() && meta.len() <= 4 << 20 => hf::decode_manifest(
            service,
            &std::fs::read(&marker).map_err(|_| Error::State("cannot read retained manifest"))?,
        )?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            report("downloading", "resolving selected immutable model", 0)?;
            let manifest = tokio::select! { ()=cancel.cancelled()=>return Err(Error::Cancelled), m=hf::resolve_manifest(service)=>m? };
            let mut file = tempfile::NamedTempFile::new_in(&model)
                .map_err(|_| Error::State("cannot retain manifest"))?;
            use std::io::Write;
            file.write_all(
                &serde_json::to_vec(&manifest).map_err(|_| Error::State("invalid manifest"))?,
            )
            .map_err(|_| Error::State("cannot retain manifest"))?;
            file.as_file()
                .sync_all()
                .map_err(|_| Error::State("cannot sync manifest"))?;
            file.persist(&marker)
                .map_err(|_| Error::State("cannot publish manifest"))?;
            manifest
        }
        _ => return Err(Error::State("retained manifest is unobservable or invalid")),
    };
    report("downloading", "verifying selected model snapshot", 0)?;
    let client = snapshot::Client::new()?;
    tokio::time::timeout(
        Duration::from_secs(8 * 3600),
        client.ensure(&model, &manifest, cancel, &|file| {
            let _ = report("downloading", file, 0);
        }),
    )
    .await
    .map_err(|_| Error::State("model download exceeded budget; partial data retained"))??;
    let mut environment: std::collections::BTreeMap<String, std::ffi::OsString> = [
        ("HF_HUB_OFFLINE", "1"),
        ("TRANSFORMERS_OFFLINE", "1"),
        ("HF_HOME", "/data/huggingface"),
        ("VLLM_CACHE_ROOT", "/data/vllm-cache"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.into()))
    .collect();
    if let Some(recipe) = &service.recipe {
        report(
            "preparing",
            "running declared recipe preparation and verification",
            0,
        )?;
        let memory = nemoclaw_sdk::hardware::linux::memory()?;
        if memory.available
            < (recipe.resources.preparation_memory_gi_b + service.memory.host_reserve_gib as u64)
                * nemoclaw_sdk::hardware::GIB
        {
            return Err(Error::Conflict(
                "memory headroom changed before recipe preparation",
            ));
        }
        let root = root.join("prepared");
        let receipt = nemoclaw_sdk::recipes::preparation::prepare(
            &root,
            &model,
            service,
            &crate::inline_recipe::PackagedRecipe(recipe),
            cancel,
        )
        .await?;
        for (key, value) in &recipe.serving.environment {
            environment.insert(key.clone(), value.into());
        }
        for (key, path) in &recipe.serving.prepared_environment {
            let directory = root.join(&receipt.key);
            environment.insert(
                key.clone(),
                if path == "." {
                    directory
                } else {
                    directory.join(path)
                }
                .into_os_string(),
            );
        }
    }
    Ok(PreparedModel { model, environment })
}
