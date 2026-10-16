// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runtime-file results must remain bound to the same Pod and retained claims.
use super::{Deployed, operations, spec};
use crate::kube_api::Objects;
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::services::{Operations, PodExec, RuntimeFile, Spec},
};
use serde_json::json;
use std::{collections::VecDeque, sync::Mutex};

const STARTED: &str = "2099-01-01T00:00:00Z";

struct Harness {
    spec: Spec,
    objects: Objects,
    operations: Operations,
    _directory: tempfile::TempDir,
    deployed: Deployed,
}
impl Harness {
    async fn new(backend: &str, authenticated: bool) -> Self {
        let spec = spec(backend, authenticated);
        let objects = Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        operations.ensure(&spec, None).await.unwrap();
        let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
        pod["status"] = json!({"phase": "Running", "containerStatuses": [{"name": "runtime", "state": {"running": {"startedAt": STARTED}}}]});
        objects.insert(pod);
        let deployed = Deployed::new(&objects, directory, fixture, operations);
        let (objects, directory, operations) = deployed.restore();
        Self {
            spec,
            objects,
            operations,
            _directory: directory,
            deployed,
        }
    }

    /// Start another case from the running model that `new` deployed.
    fn restore(&mut self) {
        (self.objects, self._directory, self.operations) = self.deployed.restore();
    }

    fn executor(&self, steps: Vec<Step>) -> Exec {
        Exec {
            objects: self.objects.clone(),
            pod: self.spec.name.clone(),
            steps: Mutex::new(steps.into()),
            calls: Mutex::new(Vec::new()),
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Change {
    PodUid,
    StartedAt,
    CredentialMount,
    CredentialPvcUid,
}
impl Change {
    fn assert_mismatch(self, error: &ObservationError, pod: &str) {
        let (kind, name, field) = match self {
            Self::PodUid => ("Pod", pod.to_owned(), "metadata.uid"),
            Self::StartedAt => (
                "Pod",
                pod.to_owned(),
                "status.containerStatuses[runtime].state.running.startedAt",
            ),
            Self::CredentialMount => (
                "Pod",
                pod.to_owned(),
                "spec.volumes.persistentVolumeClaim.claimName",
            ),
            Self::CredentialPvcUid => (
                "PersistentVolumeClaim",
                format!("{pod}-auth"),
                "metadata.uid",
            ),
        };
        super::diagnostics::assert_named_mismatch(error, kind, "agents", &name, field);
        let message = error.to_string();
        for value in ["foreign", STARTED, "2099-01-01T00:00:01Z", &"a".repeat(64)] {
            assert!(!message.contains(value), "value leaked: {message}");
        }
    }

    fn apply(self, objects: &Objects, pod: &str) {
        if matches!(self, Self::CredentialPvcUid) {
            let mut claim = objects
                .get(
                    "v1",
                    "PersistentVolumeClaim",
                    "agents",
                    &format!("{pod}-auth"),
                )
                .unwrap();
            claim["metadata"]["uid"] = json!("foreign-claim-uid");
            objects.insert(claim);
            return;
        }
        let mut object = objects.get("v1", "Pod", "agents", pod).unwrap();
        match self {
            Self::PodUid => object["metadata"]["uid"] = json!("foreign-pod-uid"),
            Self::StartedAt => {
                object["status"]["containerStatuses"][0]["state"]["running"]["startedAt"] =
                    json!("2099-01-01T00:00:01Z")
            }
            Self::CredentialMount => {
                let volume = object["spec"]["volumes"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|volume| volume["name"] == "credentials")
                    .unwrap();
                volume["persistentVolumeClaim"]["claimName"] = json!("foreign-auth");
            }
            Self::CredentialPvcUid => unreachable!(),
        }
        objects.insert(object);
    }
}

struct Step {
    file: RuntimeFile,
    bytes: Vec<u8>,
    change: Option<Change>,
}
impl Step {
    fn status(phase: &str) -> Self {
        Self { file: RuntimeFile::Status, bytes: json!({"phase": phase, "updated": STARTED, "pid": 42, "detail": "runtime observation"}).to_string().into_bytes(), change: None }
    }
}
struct Exec {
    objects: Objects,
    pod: String,
    steps: Mutex<VecDeque<Step>>,
    calls: Mutex<Vec<RuntimeFile>>,
}
#[async_trait::async_trait]
impl PodExec for Exec {
    async fn read_file(
        &self,
        namespace: &str,
        pod: &str,
        file: RuntimeFile,
    ) -> Result<Option<Vec<u8>>, ObservationError> {
        assert_eq!(namespace, "agents");
        assert_eq!(pod, self.pod);
        self.calls.lock().unwrap().push(file);
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected runtime file read");
        assert_eq!(file, step.file);
        if let Some(change) = step.change {
            change.apply(&self.objects, pod);
        }
        Ok(Some(step.bytes))
    }
}

#[tokio::test]
async fn fresh_ready_status_establishes_readiness_for_each_backend() {
    for backend in ["vllm", "ollama"] {
        let harness = Harness::new(backend, backend == "vllm").await;
        let before = harness.objects.0.lock().unwrap().clone();
        let executor = harness.executor(vec![Step::status("ready"), Step::status("ready")]);
        let observed = harness
            .operations
            .read_with_exec(&harness.spec, None, &executor)
            .await
            .unwrap();
        let ready = harness
            .operations
            .wait_ready_with_exec(&harness.spec, &executor)
            .await
            .unwrap();
        assert_eq!(observed.running, Some(true));
        assert_eq!(ready, observed);
        assert_eq!(*harness.objects.0.lock().unwrap(), before);
        assert!(executor.steps.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn runtime_reads_reject_identity_changes_during_status_exec() {
    let mut harness = Harness::new("vllm", true).await;
    for change in [
        Change::PodUid,
        Change::StartedAt,
        Change::CredentialMount,
        Change::CredentialPvcUid,
    ] {
        harness.restore();
        let mut step = Step::status("ready");
        step.change = Some(change);
        let executor = harness.executor(vec![step]);
        let error = harness
            .operations
            .read_with_exec(&harness.spec, None, &executor)
            .await
            .unwrap_err();
        change.assert_mismatch(&error, &harness.spec.name);
        assert_eq!(*executor.calls.lock().unwrap(), [RuntimeFile::Status]);
    }
}

#[tokio::test]
async fn refused_exec_upgrades_report_authentication_and_permission_without_retrying() {
    let mut harness = Harness::new("ollama", false).await;
    for (code, expected) in [
        (401, ObservationError::Authentication),
        (403, ObservationError::Permission),
        (500, ObservationError::Transport),
    ] {
        harness.restore();
        let exec = format!("/api/v1/namespaces/agents/pods/{}/exec", harness.spec.name);
        let before = harness.objects.0.lock().unwrap().clone();
        harness.objects.reject_request("GET", &exec, false, code);
        assert_eq!(
            harness.operations.read(&harness.spec, None).await,
            Err(expected.clone()),
            "{code}"
        );
        assert_eq!(harness.objects.rejected_requests().len(), 1, "{code}");
        if code != 500 {
            harness.objects.reject_request("GET", &exec, false, code);
            assert_eq!(
                harness.operations.wait_ready(&harness.spec).await,
                Err(expected),
                "{code}"
            );
            assert_eq!(harness.objects.rejected_requests().len(), 2, "{code}");
        }
        assert_eq!(*harness.objects.0.lock().unwrap(), before, "{code}");
    }
}
