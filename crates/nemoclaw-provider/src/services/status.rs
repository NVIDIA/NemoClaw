// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{Error, docker::Engine, managed::RuntimeObservation};
use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Deserialize)]
struct Status {
    phase: String,
    updated: String,
}

#[derive(Deserialize)]
struct InferenceStatus {
    phase: String,
    #[serde(rename = "detail")]
    _detail: String,
    updated: String,
    #[serde(rename = "pid")]
    _pid: u32,
}

fn timestamp(value: &str) -> Result<OffsetDateTime, Error> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| Error::State("runtime observation timestamp is incomplete"))
}

pub(super) async fn runtime_phase(
    engine: &Engine,
    observed: &RuntimeObservation,
) -> Result<String, Error> {
    let (missing, incomplete, unknown) = match observed.spec.kind.as_str() {
        vllm::SERVICE_KIND => (
            "inference runtime status is unobservable",
            "inference runtime status is incomplete",
            "unknown inference runtime status",
        ),
        ollama::SERVICE_KIND => (
            "Ollama runtime status is unobservable",
            "Ollama runtime status is incomplete",
            "unknown Ollama runtime status",
        ),
        _ => return Err(Error::State("runtime has no service readiness contract")),
    };
    let started = timestamp(&observed.started_at)?;
    let bytes = engine
        .read_file(&observed.container_id, "/data/status.json", 128 << 10)
        .await?;
    let Some(bytes) = bytes else {
        let elapsed = OffsetDateTime::now_utc() - started;
        return if elapsed >= time::Duration::ZERO && elapsed < time::Duration::seconds(30) {
            Ok("initializing".into())
        } else {
            Err(Error::State(missing))
        };
    };
    // vLLM requires detail and pid; Ollama only requires phase and updated.
    let status = if observed.spec.kind == vllm::SERVICE_KIND {
        serde_json::from_slice::<InferenceStatus>(&bytes).map(|status| Status {
            phase: status.phase,
            updated: status.updated,
        })
    } else {
        serde_json::from_slice::<Status>(&bytes)
    }
    .map_err(|_| Error::State(incomplete))?;
    if timestamp(&status.updated)? < started {
        return Ok("initializing".into());
    }
    match status.phase.as_str() {
        "initializing" | "downloading" | "loading" | "ready" | "stopped" => Ok(status.phase),
        "preparing" if observed.spec.kind == vllm::SERVICE_KIND => Ok(status.phase),
        _ => Err(Error::State(unknown)),
    }
}

#[cfg(all(test, unix))]
mod tests;
