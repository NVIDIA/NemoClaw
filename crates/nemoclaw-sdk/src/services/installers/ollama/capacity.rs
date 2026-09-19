// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{hardware_capacity, model_source};
use crate::{
    Error,
    docker::Engine,
    managed::{RuntimeObservation, Spec},
};

pub(crate) async fn check(
    engine: &Engine,
    spec: &Spec,
    observed: Option<&RuntimeObservation>,
) -> Result<(), Error> {
    spec.validate()?;
    if engine.endpoint() != spec.engine() {
        return Err(Error::Conflict(
            "capacity engine differs from Ollama runtime specification",
        ));
    }
    let service = super::configured_service(spec)?;
    let work = async {
        let host = engine.host_observer.observe(engine).await?;
        let info = engine.info().await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        hardware_capacity::check_memory(
            &service,
            &capacity,
            observed.is_none_or(|runtime| !runtime.running),
        )?;
        let directory = model_source::directory(&service);
        let cached = if let Some(observed) = observed {
            engine
                .read_file(
                    &observed.container_id,
                    &format!("/data/{directory}/{}", model_source::MANIFEST_FILE),
                    4 << 20,
                )
                .await?
        } else {
            None
        };
        let cached = cached
            .as_deref()
            .map(|bytes| model_source::decode_manifest(&service, bytes))
            .transpose()?;
        let manifest = match &cached {
            Some(local) => local.snapshot(),
            None => model_source::resolve_manifest(&service).await?,
        };
        if let (Some(observed), Some(_)) = (observed, &cached)
            && let Some(native) = engine
                .read_file(
                    &observed.container_id,
                    &format!(
                        "/data/{directory}/{}",
                        model_source::native_manifest_path(&service)?
                    ),
                    1 << 20,
                )
                .await?
        {
            model_source::validate_native_manifest(&service, &manifest, &native)?;
        }
        let mut download = manifest.bytes()?;
        if let Some(observed) = observed {
            for (index, file) in manifest.files.iter().enumerate() {
                let base = format!("/data/{directory}/{}", file.name);
                if let Some(modified) = cached
                    .as_ref()
                    .and_then(|local| local.files[index].modified)
                {
                    let stat = engine
                        .stat_file(&observed.container_id, &base)
                        .await?
                        .ok_or(Error::Conflict(
                            "verified Ollama model file is missing; retained for inspection",
                        ))?;
                    super::super::vllm::artifacts::verify_stat(
                        &crate::snapshot::VerifiedFile {
                            file: file.clone(),
                            modified,
                        },
                        &stat,
                    )?;
                    download -= file.size;
                    continue;
                }
                for suffix in ["", ".nemoclaw-partial"] {
                    if let Some(stat) = engine
                        .stat_file(&observed.container_id, &format!("{base}{suffix}"))
                        .await?
                    {
                        if !super::super::vllm::capacity::regular_stat(&stat)
                            || stat.size < 0
                            || stat.size as u64 > file.size
                        {
                            return Err(Error::Conflict(
                                "retained Ollama download progress is corrupt",
                            ));
                        }
                        download -= stat.size as u64;
                        break;
                    }
                }
            }
        }
        hardware_capacity::check_capacity(
            &service,
            &capacity,
            observed.is_none_or(|runtime| !runtime.running),
            download,
        )
    };
    tokio::time::timeout(std::time::Duration::from_secs(150), work)
        .await
        .map_err(|_| Error::State("Ollama host capacity observation timed out"))?
}
