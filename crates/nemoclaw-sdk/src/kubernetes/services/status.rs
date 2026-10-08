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

/// The only runtime files a cluster observer may read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeFile {
    Status,
    Credential,
}

/// Bounded file reads from a Pod whose ownership the caller verifies before and after exec.
#[async_trait::async_trait]
pub trait PodExec: Send + Sync {
    async fn read_file(
        &self,
        namespace: &str,
        pod: &str,
        file: RuntimeFile,
    ) -> Result<Option<Vec<u8>>, ObservationError>;
}

pub(super) struct KubernetesExec(pub kube::Client);
#[async_trait::async_trait]
impl PodExec for KubernetesExec {
    async fn read_file(
        &self,
        namespace: &str,
        pod: &str,
        file: RuntimeFile,
    ) -> Result<Option<Vec<u8>>, ObservationError> {
        execute(
            self.0.clone(),
            namespace,
            pod,
            file == RuntimeFile::Credential,
        )
        .await
    }
}

#[derive(Deserialize)]
struct Status {
    phase: String,
    updated: String,
    pid: u32,
    detail: String,
}

/// Prefer authoritative Pod failures over the container's generic exit reason.
pub(super) fn terminal(pod: &DynamicObject, owned_name: &str) -> Option<ObservationError> {
    use serde_json::Value;
    let phase = pod.data.pointer("/status/phase").and_then(Value::as_str);
    let container = pod
        .data
        .pointer("/status/containerStatuses")
        .and_then(Value::as_array)
        .and_then(|containers| {
            containers
                .iter()
                .find(|container| container["name"] == "runtime")
        });
    let waiting = container
        .and_then(|container| container.pointer("/state/waiting/reason"))
        .and_then(Value::as_str);
    let waiting = match waiting {
        Some("ErrImageNeverPull") => Some("ErrImageNeverPull"),
        Some("InvalidImageName") => Some("InvalidImageName"),
        _ => None,
    };
    if let Some(reason) = waiting {
        return Some(ObservationError::ModelRuntimeStopped {
            reason,
            exit_code: None,
            detail: "".into(),
        });
    }
    let terminated = container.and_then(|container| container.pointer("/state/terminated"));
    if !matches!(phase, Some("Failed" | "Succeeded")) && terminated.is_none() {
        return None;
    }
    let pod_reason = match pod.data.pointer("/status/reason").and_then(Value::as_str) {
        Some("Evicted") => Some("Evicted"),
        Some("DeadlineExceeded") => Some("DeadlineExceeded"),
        Some("NodeLost") => Some("NodeLost"),
        Some("NodeAffinity") => Some("NodeAffinity"),
        Some("UnexpectedAdmissionError") => Some("UnexpectedAdmissionError"),
        Some(value) if value.starts_with("OutOf") => Some("OutOfResources"),
        _ => None,
    };
    let reason = if phase == Some("Failed") {
        pod_reason
    } else {
        None
    }
    .unwrap_or_else(
        || match terminated.and_then(|state| state["reason"].as_str()) {
            Some("OOMKilled") => "OOMKilled",
            Some("Error") => "Error",
            Some("Completed") => "Completed",
            Some("ContainerStatusUnknown") => "ContainerStatusUnknown",
            _ if phase == Some("Succeeded") => "Completed",
            _ => "Failed",
        },
    );
    let exit_code = terminated
        .and_then(|state| state["exitCode"].as_i64())
        .and_then(|code| i32::try_from(code).ok());
    let detail = terminated
        .and_then(|state| state["message"].as_str())
        .and_then(|message| {
            message
                .lines()
                .rev()
                .find_map(|line| line.split_once("stopped:").map(|(_, detail)| detail))
        })
        .unwrap_or("");
    Some(ObservationError::ModelRuntimeStopped {
        reason,
        exit_code,
        detail: ObservationError::sanitized_resource_detail(detail, owned_name),
    })
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
) -> Result<String, ObservationError> {
    let bytes = bytes.ok_or(ObservationError::Incomplete)?;
    let status: Status = serde_json::from_slice(bytes).map_err(|_| ObservationError::Incomplete)?;
    let updated = OffsetDateTime::parse(&status.updated, &Rfc3339)
        .map_err(|_| ObservationError::Incomplete)?;
    // Both timestamps originate on the node. The observing CLI clock is unrelated.
    if updated < started || status.detail.len() > 64 * 1024 {
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
    fn terminal_reasons_prefer_pod_failures_and_leave_transient_kubelet_waiting_retryable() {
        for (pod_reason, container_reason, expected) in [
            ("Evicted", "Error", "Evicted"),
            ("DeadlineExceeded", "Error", "DeadlineExceeded"),
            ("NodeLost", "Error", "NodeLost"),
            ("NodeAffinity", "Error", "NodeAffinity"),
            (
                "UnexpectedAdmissionError",
                "Error",
                "UnexpectedAdmissionError",
            ),
            ("OutOfmemory", "Error", "OutOfResources"),
            (
                "Unrecognized",
                "ContainerStatusUnknown",
                "ContainerStatusUnknown",
            ),
        ] {
            let pod = serde_json::from_value(serde_json::json!({
                "apiVersion": "v1", "kind": "Pod", "metadata": {},
                "status": {"phase": "Failed", "reason": pod_reason, "message": "private-kubelet-message",
                    "containerStatuses": [{"name":"runtime", "state": {"terminated": {"reason": container_reason, "exitCode": 1}}}]}
            })).unwrap();
            assert_eq!(
                terminal(&pod, "model"),
                Some(ObservationError::ModelRuntimeStopped {
                    reason: expected,
                    exit_code: Some(1),
                    detail: "".into()
                })
            );
        }
        let pod = serde_json::from_value(serde_json::json!({
            "apiVersion": "v1", "kind": "Pod", "metadata": {},
            "status": {"phase": "Pending", "containerStatuses": [{"name":"runtime", "state": {"waiting": {"reason": "CreateContainerConfigError", "message": "failed to sync configmap cache"}}}]}
        })).unwrap();
        assert_eq!(terminal(&pod, "model"), None);
    }

    #[test]
    fn readiness_requires_a_fresh_status_with_a_nonzero_process_identifier() {
        let started = OffsetDateTime::parse("2026-10-07T01:00:00Z", &Rfc3339).unwrap();
        for (updated, pid, expected) in [
            (
                "2026-10-07T00:59:59Z",
                42,
                Err(ObservationError::Incomplete),
            ),
            ("2026-10-07T01:00:00Z", 0, Err(ObservationError::Incomplete)),
            ("2026-10-07T01:00:00Z", 42, Ok("ready".into())),
        ] {
            let status = serde_json::json!({"phase": "ready", "updated": updated, "pid": pid, "detail": "ready"}).to_string();
            assert_eq!(phase(Some(status.as_bytes()), started), expected);
        }
        assert_eq!(phase(None, started), Err(ObservationError::Incomplete));
    }
}
