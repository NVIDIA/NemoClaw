// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runtime observations exercise the owning operations through an injected exec transport.
use super::{operations, spec};
use crate::kube_api::Objects;
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::services::{PodExec, RuntimeFile},
};
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

type ExecReply = (RuntimeFile, Result<Option<Vec<u8>>, ObservationError>);
struct Exec {
    results: Mutex<std::collections::VecDeque<ExecReply>>,
    calls: AtomicUsize,
}
impl Exec {
    fn new(results: Vec<ExecReply>) -> Self {
        Self {
            results: Mutex::new(results.into()),
            calls: AtomicUsize::new(0),
        }
    }
}
#[async_trait::async_trait]
impl PodExec for Exec {
    async fn read_file(
        &self,
        _: &str,
        _: &str,
        file: RuntimeFile,
    ) -> Result<Option<Vec<u8>>, ObservationError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (expected, result) = self
            .results
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected runtime exec");
        assert_eq!(file, expected);
        result
    }
}

#[tokio::test]
async fn terminal_runtime_status_reports_the_stop_detail_before_attempting_exec() {
    let spec = spec("ollama", false);
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    pod["status"] = json!({"phase": "Failed", "containerStatuses": [{"name":"runtime", "state": {"terminated": {"reason": "Error", "exitCode": 1, "message": "model output\nstopped: Ollama tag differs from the pinned manifest digest"}}}]});
    objects.insert(pod);
    let executor = Exec::new(Vec::new());
    let error = operations
        .wait_ready_with_exec(&spec, &executor)
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Ollama tag differs from the pinned manifest digest"),
        "{error}"
    );
    assert!(matches!(
        error,
        ObservationError::ModelRuntimeStopped {
            reason: "Error",
            exit_code: Some(1),
            ..
        }
    ));
    assert_eq!(executor.calls.load(Ordering::SeqCst), 0);
}

fn running(objects: &Objects, name: &str, started: &str) {
    let mut pod = objects.get("v1", "Pod", "agents", name).unwrap();
    pod["status"] = json!({"phase": "Running", "containerStatuses": [{"name":"runtime", "state": {"running": {"startedAt": started}}}]});
    objects.insert(pod);
}
fn ready(updated: &str) -> Vec<u8> {
    json!({"phase":"ready", "updated": updated, "pid": 42, "detail":"serving"})
        .to_string()
        .into_bytes()
}

#[tokio::test]
async fn runtime_freshness_uses_node_timestamps_even_when_the_cli_clock_differs() {
    let spec = spec("ollama", false);
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let started = "2099-01-01T00:00:00Z";
    running(&objects, &spec.name, started);
    let executor = Exec::new(vec![(RuntimeFile::Status, Ok(Some(ready(started))))]);
    assert_eq!(
        operations
            .read_with_exec(&spec, None, &executor)
            .await
            .unwrap()
            .running,
        Some(true)
    );
}

struct ExitDuringExec {
    objects: Objects,
    calls: AtomicUsize,
}
#[async_trait::async_trait]
impl PodExec for ExitDuringExec {
    async fn read_file(
        &self,
        namespace: &str,
        name: &str,
        file: RuntimeFile,
    ) -> Result<Option<Vec<u8>>, ObservationError> {
        assert_eq!(file, RuntimeFile::Status);
        assert_eq!(self.calls.fetch_add(1, Ordering::SeqCst), 0);
        let mut pod = self.objects.get("v1", "Pod", namespace, name).unwrap();
        pod["status"] = json!({"phase": "Failed", "containerStatuses": [{"name":"runtime", "state": {"terminated": {"reason": "Error", "exitCode": 1, "message": "private log tail\nstopped: Ollama tag differs from the pinned manifest digest"}}}]});
        self.objects.insert(pod);
        Err(ObservationError::Transport)
    }
}

#[tokio::test]
async fn readiness_retries_failed_status_reads_and_reports_the_runtime_stop_reason() {
    let spec = spec("ollama", false);
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    running(&objects, &spec.name, "2026-10-07T01:00:00Z");
    let executor = ExitDuringExec {
        objects: objects.clone(),
        calls: AtomicUsize::new(0),
    };
    let error = operations
        .wait_ready_with_exec(&spec, &executor)
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ObservationError::ModelRuntimeStopped {
            reason: "Error",
            exit_code: Some(1),
            ..
        }
    ));
    assert!(
        error
            .to_string()
            .contains("Ollama tag differs from the pinned manifest digest")
    );
    assert!(!error.to_string().contains("private log tail"));
    assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn readiness_fails_fast_on_permanent_waiting_reasons_without_echoing_kubelet_text() {
    let spec = spec("ollama", false);
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let executor = Exec::new(Vec::new());
    for reason in ["ErrImageNeverPull", "InvalidImageName"] {
        let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
        pod["status"] = json!({"phase": "Pending", "containerStatuses": [{"name":"runtime", "state": {"waiting": {"reason": reason, "message": "private-kubelet-message"}}}]});
        objects.insert(pod);
        let error = operations
            .wait_ready_with_exec(&spec, &executor)
            .await
            .unwrap_err();
        assert!(error.to_string().contains(reason));
        assert!(error.to_string().contains("cannot start"));
        assert!(!error.to_string().contains("private-kubelet-message"));
        assert!(!error.to_string().contains("logs"));
    }
    assert_eq!(executor.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn readiness_still_fails_fast_when_the_pod_binding_changes() {
    let spec = spec("ollama", false);
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    pod["metadata"]["uid"] = json!("replacement");
    objects.insert(pod);
    let executor = Exec::new(Vec::new());
    assert_eq!(
        operations.wait_ready_with_exec(&spec, &executor).await,
        Err(ObservationError::BindingMismatch)
    );
    assert_eq!(executor.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn terminal_readiness_still_verifies_the_retained_namespace_identity() {
    let spec = spec("ollama", false);
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    pod["status"] = json!({"phase": "Failed"});
    objects.insert(pod);
    let mut namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
    namespace["metadata"]["uid"] = json!("substituted-namespace");
    objects.insert(namespace);
    let executor = Exec::new(Vec::new());
    assert_eq!(
        operations.wait_ready_with_exec(&spec, &executor).await,
        Err(ObservationError::BindingMismatch)
    );
    assert_eq!(executor.calls.load(Ordering::SeqCst), 0);
}
