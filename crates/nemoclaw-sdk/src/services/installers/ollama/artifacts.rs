// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::model_source;
use crate::{Error, docker::Engine, managed::RuntimeObservation, snapshot::VerifiedFile};
use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Deserialize)]
pub(crate) struct RuntimeStatus {
    pub phase: String,
    updated: String,
}

fn timestamp(value: &str) -> Result<OffsetDateTime, Error> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| Error::State("runtime observation timestamp is incomplete"))
}

pub(crate) async fn runtime_status(
    engine: &Engine,
    observed: &RuntimeObservation,
) -> Result<RuntimeStatus, Error> {
    let started = timestamp(&observed.started_at)?;
    let bytes = engine
        .read_file(&observed.container_id, "/data/status.json", 128 << 10)
        .await?;
    let Some(bytes) = bytes else {
        let elapsed = OffsetDateTime::now_utc() - started;
        if elapsed >= time::Duration::ZERO && elapsed < time::Duration::seconds(30) {
            return Ok(RuntimeStatus {
                phase: "initializing".into(),
                updated: String::new(),
            });
        }
        return Err(Error::State("Ollama runtime status is unobservable"));
    };
    let status: RuntimeStatus = serde_json::from_slice(&bytes)
        .map_err(|_| Error::State("Ollama runtime status is incomplete"))?;
    if timestamp(&status.updated)? < started {
        return Ok(RuntimeStatus {
            phase: "initializing".into(),
            updated: String::new(),
        });
    }
    if !matches!(
        status.phase.as_str(),
        "initializing" | "downloading" | "loading" | "ready" | "stopped"
    ) {
        return Err(Error::State("unknown Ollama runtime status"));
    }
    Ok(status)
}

pub(crate) async fn verify(engine: &Engine, observed: &RuntimeObservation) -> Result<(), Error> {
    let work = async {
        let service = super::configured_service(&observed.spec)?;
        let model = format!("/data/{}", model_source::directory(&service));
        let bytes = engine
            .read_file(
                &observed.container_id,
                &format!("{model}/{}", model_source::MANIFEST_FILE),
                4 << 20,
            )
            .await?
            .ok_or(Error::State(
                "selected Ollama model manifest is unobservable",
            ))?;
        let manifest = model_source::decode_manifest(&service, &bytes)?;
        let native = engine
            .read_file(
                &observed.container_id,
                &format!("{model}/{}", model_source::native_manifest_path(&service)?),
                1 << 20,
            )
            .await?
            .ok_or(Error::State("Ollama native manifest is unobservable"))?;
        model_source::validate_native_manifest(&service, &manifest.snapshot(), &native)?;
        for file in &manifest.verified_files()? {
            verify_file(engine, &observed.container_id, &model, file).await?;
        }
        Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), work)
        .await
        .map_err(|_| Error::State("Ollama artifact observation timed out"))?
}

async fn verify_file(
    engine: &Engine,
    id: &str,
    directory: &str,
    file: &VerifiedFile,
) -> Result<(), Error> {
    let stat = engine
        .stat_file(id, &format!("{directory}/{}", file.file.name))
        .await?
        .ok_or(Error::State(
            "verified Ollama artifact is unobservable; runtime absence is unconfirmed",
        ))?;
    super::super::vllm::artifacts::verify_stat(file, &stat)
}
