// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, docker::Engine, managed::RuntimeObservation};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RuntimeStatus {
    pub phase: String,
    pub detail: String,
    pub updated: String,
    pub pid: u32,
}
fn timestamp(value: &str) -> Result<OffsetDateTime, Error> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| Error::State("runtime observation timestamp is incomplete"))
}
impl RuntimeStatus {
    fn initializing() -> Self {
        Self {
            phase: "initializing".into(),
            detail: String::new(),
            updated: String::new(),
            pid: 0,
        }
    }
}
impl Engine {
    pub async fn runtime_status(
        &self,
        observed: &RuntimeObservation,
    ) -> Result<RuntimeStatus, Error> {
        let started = timestamp(&observed.started_at)?;
        let bytes = self
            .read_file(&observed.container_id, "/data/status.json", 128 << 10)
            .await?;
        let Some(bytes) = bytes else {
            let elapsed = OffsetDateTime::now_utc() - started;
            if elapsed >= time::Duration::ZERO && elapsed < time::Duration::seconds(30) {
                return Ok(RuntimeStatus::initializing());
            }
            return Err(Error::State("inference runtime status is unobservable"));
        };
        let status: RuntimeStatus = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("inference runtime status is incomplete"))?;
        if timestamp(&status.updated)? < started {
            return Ok(RuntimeStatus::initializing());
        }
        match status.phase.as_str() {
            "initializing" | "downloading" | "preparing" | "loading" | "ready" | "stopped" => {
                Ok(status)
            }
            _ => Err(Error::State("unknown inference runtime status")),
        }
    }
}
#[cfg(all(test, unix))]
#[path = "artifacts_tests.rs"]
mod tests;
