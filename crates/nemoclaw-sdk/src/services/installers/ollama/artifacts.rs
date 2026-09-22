// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Error, docker::Engine, managed::RuntimeObservation};
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
