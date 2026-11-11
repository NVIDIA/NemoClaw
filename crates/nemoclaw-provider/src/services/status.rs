// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{Error, docker::Engine};
use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Deserialize)]
struct Status {
    phase: String,
    updated: String,
    // Ollama's status doesn't require a detail.
    #[serde(default)]
    detail: serde_json::Value,
}

#[derive(Deserialize)]
struct InferenceStatus {
    phase: String,
    detail: String,
    updated: String,
    #[serde(rename = "pid")]
    _pid: u32,
}

/// What a runtime reports in its status file: its phase, and the runtime's
/// detail, which says why a stopped runtime stopped.
pub(super) struct RuntimeStatus {
    pub phase: String,
    pub detail: String,
}

impl RuntimeStatus {
    fn starting() -> Self {
        Self {
            phase: "initializing".into(),
            detail: String::new(),
        }
    }
}

fn timestamp(value: &str) -> Result<OffsetDateTime, Error> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| Error::State("runtime observation timestamp is incomplete"))
}

#[cfg(test)]
pub(super) async fn runtime_phase(
    engine: &Engine,
    observed: &crate::managed::RuntimeObservation,
) -> Result<String, Error> {
    read(
        engine,
        &observed.spec.kind,
        &observed.container_id,
        &observed.started_at,
    )
    .await
    .map(|status| status.phase)
}

/// The status a `kind` runtime reports in its status file.
pub(super) async fn read(
    engine: &Engine,
    kind: &str,
    container_id: &str,
    started_at: &str,
) -> Result<RuntimeStatus, Error> {
    let (missing, incomplete, unknown) = match kind {
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
    let started = timestamp(started_at)?;
    let bytes = engine
        .read_file(container_id, "/data/status.json", 128 << 10)
        .await?;
    let Some(bytes) = bytes else {
        let elapsed = OffsetDateTime::now_utc() - started;
        return if elapsed >= time::Duration::ZERO && elapsed < time::Duration::seconds(30) {
            Ok(RuntimeStatus::starting())
        } else {
            Err(Error::State(missing))
        };
    };
    // vLLM requires detail and pid; Ollama only requires phase and updated.
    let status = if kind == vllm::SERVICE_KIND {
        serde_json::from_slice::<InferenceStatus>(&bytes).map(|status| Status {
            phase: status.phase,
            updated: status.updated,
            detail: status.detail.into(),
        })
    } else {
        serde_json::from_slice::<Status>(&bytes)
    }
    .map_err(|_| Error::State(incomplete))?;
    if timestamp(&status.updated)? < started {
        return Ok(RuntimeStatus::starting());
    }
    match status.phase.as_str() {
        "initializing" | "downloading" | "loading" | "ready" | "stopped" => {}
        "preparing" if kind == vllm::SERVICE_KIND => {}
        _ => return Err(Error::State(unknown)),
    }
    Ok(RuntimeStatus {
        detail: status.detail.as_str().unwrap_or_default().into(),
        phase: status.phase,
    })
}

#[cfg(test)]
mod tests;
