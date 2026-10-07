// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Only a fresh runtime status from the recorded running container establishes readiness.
use crate::ObservationError;
use k8s_openapi::api::core::v1::Pod;
use kube::{
    Api,
    api::{AttachParams, DynamicObject},
};
use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::io::AsyncReadExt;

#[derive(Deserialize)]
struct Status {
    phase: String,
    updated: String,
    pid: u32,
    detail: String,
}

pub(super) fn started(pod: &DynamicObject) -> Result<OffsetDateTime, ObservationError> {
    let containers = pod
        .data
        .pointer("/status/containerStatuses")
        .and_then(serde_json::Value::as_array)
        .ok_or(ObservationError::Incomplete)?;
    let started = containers
        .iter()
        .find(|container| container["name"] == "runtime")
        .and_then(|container| container.pointer("/state/running/startedAt"))
        .and_then(serde_json::Value::as_str)
        .ok_or(ObservationError::Incomplete)?;
    OffsetDateTime::parse(started, &Rfc3339).map_err(|_| ObservationError::Incomplete)
}

pub(super) fn phase(
    bytes: Option<&[u8]>,
    started: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<String, ObservationError> {
    let Some(bytes) = bytes else {
        return if now >= started && now - started < time::Duration::seconds(30) {
            Ok("initializing".into())
        } else {
            Err(ObservationError::Incomplete)
        };
    };
    let status: Status = serde_json::from_slice(bytes).map_err(|_| ObservationError::Incomplete)?;
    let updated = OffsetDateTime::parse(&status.updated, &Rfc3339)
        .map_err(|_| ObservationError::Incomplete)?;
    if updated < started {
        return Ok("initializing".into());
    }
    if updated > now + time::Duration::seconds(30) || status.detail.len() > 64 * 1024 {
        return Err(ObservationError::Incomplete);
    }
    match status.phase.as_str() {
        "initializing" | "downloading" | "preparing" | "loading" | "stopped" => Ok(status.phase),
        "ready" if status.pid > 0 => Ok(status.phase),
        _ => Err(ObservationError::Incomplete),
    }
}

fn failure(error: kube::Error) -> ObservationError {
    match error {
        kube::Error::Api(status) if status.code == 401 => ObservationError::Authentication,
        kube::Error::Api(status) if status.code == 403 => ObservationError::Permission,
        kube::Error::Api(_) => ObservationError::Query,
        _ => ObservationError::Transport,
    }
}

/// Read a fixed command's bounded output. The caller verifies Pod identity on both sides.
pub(super) async fn execute(
    client: kube::Client,
    namespace: &str,
    name: &str,
    credential: bool,
) -> Result<Option<Vec<u8>>, ObservationError> {
    let pods: Api<Pod> = Api::namespaced(client, namespace);
    // A successful read cannot follow a symlink or accept a key with additional readers/writers.
    let command = if credential {
        vec![
            "/bin/sh",
            "-c",
            "set -eu; test ! -L /credentials/inference-key; test ! -L /credentials/inference-key-initialized; test \"$(stat -c '%a:%h:%s:%u' /credentials/inference-key)\" = \"600:1:64:$(id -u)\"; test \"$(cat /credentials/inference-key-initialized)\" = v1; cat /credentials/inference-key",
        ]
    } else {
        vec!["/bin/cat", "/data/status.json"]
    };
    let timeout = std::time::Duration::from_secs(10);
    let mut process = tokio::time::timeout(
        timeout,
        pods.exec(
            name,
            command,
            &AttachParams::default()
                .container("runtime")
                .stdin(false)
                .stdout(true)
                .stderr(false)
                .tty(false),
        ),
    )
    .await
    .map_err(|_| ObservationError::Transport)?
    .map_err(failure)?;
    let stdout = process.stdout().ok_or(ObservationError::Incomplete)?;
    let status = process.take_status().ok_or(ObservationError::Incomplete)?;
    let limit = if credential { 64 } else { 128 << 10 };
    let result = tokio::time::timeout(timeout, async move {
        let mut bytes = Vec::new();
        stdout
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| ObservationError::Transport)?;
        if bytes.len() as u64 > limit {
            return Err(ObservationError::Incomplete);
        }
        let status = status.await.ok_or(ObservationError::Incomplete)?;
        if status.status.as_deref() == Some("Success") {
            Ok(Some(bytes))
        } else if !credential && bytes.is_empty() {
            Ok(None)
        } else {
            Err(ObservationError::Incomplete)
        }
    })
    .await;
    process.abort();
    let _ = process.join().await;
    result.map_err(|_| ObservationError::Transport)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_requires_a_fresh_status_with_a_nonzero_process_identifier() {
        let started = OffsetDateTime::parse("2026-10-07T01:00:00Z", &Rfc3339).unwrap();
        for (updated, pid, expected) in [
            ("2026-10-07T00:59:59Z", 42, Ok("initializing".into())),
            ("2026-10-07T01:00:00Z", 0, Err(ObservationError::Incomplete)),
            ("2026-10-07T01:00:00Z", 42, Ok("ready".into())),
        ] {
            let status = serde_json::json!({"phase": "ready", "updated": updated, "pid": pid, "detail": "ready"}).to_string();
            assert_eq!(phase(Some(status.as_bytes()), started, started), expected);
        }
        assert_eq!(phase(None, started, started), Ok("initializing".into()));
        assert_eq!(
            phase(None, started, started + time::Duration::seconds(30)),
            Err(ObservationError::Incomplete)
        );
    }
}
