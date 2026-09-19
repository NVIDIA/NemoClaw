// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::runtime::report;
use nemoclaw_sdk::{
    CancellationToken, Error,
    services::installers::ollama::{ManagedOllama, model_source},
    snapshot,
};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) async fn prepare(
    service: &ManagedOllama,
    root: &Path,
    cancel: &CancellationToken,
) -> Result<PathBuf, Error> {
    let model = snapshot::directory(root, &model_source::directory(service))?;
    let manifest = match snapshot::ModelManifest::read(&model)? {
        Some(manifest) => {
            let expected = manifest.snapshot();
            model_source::validate_manifest(service, &expected)?;
            expected
        }
        None => {
            report(
                "downloading",
                "resolving selected immutable Ollama model",
                0,
            )?;
            tokio::select! {
                () = cancel.cancelled() => return Err(Error::Cancelled),
                manifest = model_source::resolve_manifest(service) => manifest?,
            }
        }
    };
    report("downloading", "verifying selected Ollama model snapshot", 0)?;
    let client = model_source::client(service)?;
    tokio::time::timeout(
        Duration::from_secs(8 * 3600),
        client.ensure(&model, &manifest, cancel, &|file| {
            let _ = report("downloading", file, 0);
        }),
    )
    .await
    .map_err(|_| Error::State("Ollama model download exceeded budget; partial data retained"))??;
    let native = std::fs::read(model.join(model_source::native_manifest_path(service)?))
        .map_err(|_| Error::State("Ollama native manifest is unobservable"))?;
    model_source::validate_native_manifest(service, &manifest, &native)?;
    model_source::validate_parameters(&model, &native)?;
    Ok(model)
}
