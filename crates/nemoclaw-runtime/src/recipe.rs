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
    use nemoclaw_sdk::model_source;
    if let Some(recipe) = &service.recipe {
        crate::inline_recipe::PackagedRecipe(recipe).validate_files()?;
    }

    let model = snapshot::directory(root, &model_source::directory(service))?;
    let manifest = match snapshot::ModelManifest::read(&model)? {
        Some(manifest) => {
            let expected = manifest.snapshot();
            model_source::validate_manifest(service, &expected)?;
            expected
        }
        None => {
            report("downloading", "resolving selected immutable model", 0)?;
            tokio::select! { ()=cancel.cancelled()=>return Err(Error::Cancelled), m=model_source::resolve_manifest(service)=>m? }
        }
    };
    report("downloading", "verifying selected model snapshot", 0)?;
    let client = model_source::client(service)?;
    tokio::time::timeout(
        Duration::from_secs(8 * 3600),
        client.ensure(&model, &manifest, cancel, &|file| {
            let _ = report("downloading", file, 0);
        }),
    )
    .await
    .map_err(|_| Error::State("model download exceeded budget; partial data retained"))??;
    if service.backend == "ollama" {
        let native = std::fs::read(model.join(model_source::native_manifest_path(service)?))
            .map_err(|_| Error::State("Ollama native manifest is unobservable"))?;
        model_source::validate_native_manifest(service, &manifest, &native)?;
        model_source::validate_ollama_parameters(&model, &native)?;
        return Ok(PreparedModel {
            model,
            environment: Default::default(),
        });
    }
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
        let output = nemoclaw_sdk::recipes::preparation::prepare(
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
            let directory = root.join(&output.key);
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
