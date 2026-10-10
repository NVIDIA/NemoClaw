// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fault injection around the in-memory Kubernetes API for recovery tests.
//!
//! A test chooses which requests fail (an HTTP status, a dropped connection,
//! or a lost response after the write committed), reads back every request the
//! server received, and checks that the cluster objects and the files under a
//! state directory are unchanged. Unfaulted requests go to `kube_api::Objects`.
//! Inject only 401, 403, 500 or a dropped connection: the kube client retries
//! 429, 503 and 504 for minutes.

#![allow(dead_code)]
use crate::kube_api::{Objects, client, status};
use crate::transport::Fixture;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

/// The owner and gateway name of the deployments that `platform` builds.
pub const OWNER: &str = "00000000-0000-4000-8000-000000000001";
pub const NAME: &str = "nc-0123456789abcdef-gateway";

/// How the API server fails one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    /// Answer with a Kubernetes `Status` of this code; the request is not applied.
    Status(u16),
    /// Close the connection without answering; the request is not applied.
    Dropped,
    /// Apply the request to the objects, then close the connection without
    /// answering: the write happened and the response was lost.
    CommitThenDrop,
    /// Apply the request, then answer with the object minus its UID. A
    /// Kubernetes API server never does this; it exercises how the client
    /// handles an incomplete answer.
    CommitThenOmitUid,
}

/// A request as the server saw it: the method and the path without its query.
pub type Seen = (String, String);

/// A fake API server that injects faults chosen by a rule.
pub struct FaultServer {
    fixture: Fixture,
    log: Arc<Mutex<Vec<Seen>>>,
    fired: Arc<AtomicUsize>,
}

/// Serve `objects` and call `rule(method, path, body)` for every request, with
/// the query string stripped from `path`. `Some(fault)` injects it; `None`
/// answers from `objects`. Every request that reaches the server is logged,
/// including the ones that are faulted.
pub async fn serve(
    objects: &Objects,
    mut rule: impl FnMut(&str, &str, &[u8]) -> Option<Fault> + Send + 'static,
) -> FaultServer {
    let log: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let fired = Arc::new(AtomicUsize::new(0));
    let (served, seen, count) = (objects.clone(), log.clone(), fired.clone());
    let fixture = Fixture::start_tcp(move |request| {
        let path = request.path.split('?').next().unwrap();
        seen.lock()
            .unwrap()
            .push((request.method.clone(), path.to_owned()));
        let fault = rule(&request.method, path, &request.body);
        if fault.is_some() {
            count.fetch_add(1, Ordering::SeqCst);
        }
        let answer = || served.answer(&request.method, &request.path, &request.body);
        match fault {
            None => answer(),
            Some(Fault::Dropped) => None,
            Some(Fault::CommitThenDrop) => {
                answer();
                None
            }
            Some(Fault::CommitThenOmitUid) => {
                let (code, body) = answer()?;
                let mut object: Value = serde_json::from_slice(&body).unwrap();
                object["metadata"].as_object_mut().unwrap().remove("uid");
                Some((code, object.to_string().into_bytes()))
            }
            Some(Fault::Status(code)) => status(code, "Injected"),
        }
    })
    .await;
    FaultServer {
        fixture,
        log,
        fired,
    }
}

impl FaultServer {
    /// The `http://127.0.0.1:PORT` address to pass as `Operations::server`.
    pub fn endpoint(&self) -> &str {
        &self.fixture.endpoint
    }

    pub fn client(&self) -> kube::Client {
        client(&self.fixture)
    }

    /// Every request received, in order, faulted or not.
    pub fn requests(&self) -> Vec<Seen> {
        self.log.lock().unwrap().clone()
    }

    /// How many requests the rule faulted.
    pub fn faults_fired(&self) -> usize {
        self.fired.load(Ordering::SeqCst)
    }

    /// Requests that could change the cluster: every request that is not a
    /// GET. A faulted write counts, because the server received it.
    pub fn mutations(&self) -> Vec<Seen> {
        let mut writes = self.requests();
        writes.retain(|(method, _)| method != "GET");
        writes
    }
}

/// The cluster objects and the contents of every regular file under a state
/// directory. Empty directories and file modes are not recorded.
#[derive(Debug, PartialEq)]
pub struct Snapshot {
    objects: BTreeMap<String, Value>,
    files: BTreeMap<PathBuf, Vec<u8>>,
}

fn read_files(root: &Path, directory: &Path, files: &mut BTreeMap<PathBuf, Vec<u8>>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.map(|entry| entry.unwrap().path()) {
        if entry.is_dir() {
            read_files(root, &entry, files);
        } else {
            let relative = entry.strip_prefix(root).unwrap().to_owned();
            files.insert(relative, std::fs::read(&entry).unwrap());
        }
    }
}

/// The first key whose value differs between two maps, as a message.
fn first_difference<K: Ord + std::fmt::Debug, V: PartialEq + std::fmt::Debug>(
    what: &str,
    before: &BTreeMap<K, V>,
    after: &BTreeMap<K, V>,
) -> Option<String> {
    let key = before
        .keys()
        .chain(after.keys())
        .find(|key| before.get(key) != after.get(key))?;
    Some(format!(
        "{what} {key:?} changed: before {:?}, after {:?}",
        before.get(key),
        after.get(key)
    ))
}

impl Snapshot {
    pub fn capture(objects: &Objects, state_dir: &Path) -> Self {
        let mut files = BTreeMap::new();
        read_files(state_dir, state_dir, &mut files);
        Self {
            objects: objects.0.lock().unwrap().clone(),
            files,
        }
    }

    /// Panic, naming `context` and the first difference, unless the objects and
    /// the file contents are as captured.
    pub fn assert_unchanged(&self, objects: &Objects, state_dir: &Path, context: &str) {
        let now = Self::capture(objects, state_dir);
        let difference = first_difference("object", &self.objects, &now.objects)
            .or_else(|| first_difference("state file", &self.files, &now.files));
        if let Some(difference) = difference {
            panic!("{context}: {difference}");
        }
    }
}

/// Fixtures for the Kubernetes platform operations, copied from
/// `kubernetes_operations.rs` (which keeps its own copy) so fault tests build
/// the same cluster and specs.
#[cfg(unix)]
pub mod platform {
    pub use super::{NAME, OWNER};
    use crate::kube_api::Objects;
    use nemoclaw_sdk::{
        Error, ObservationError,
        kubernetes::{GATEWAY_KIND, Spec, operations::Operations},
    };
    use serde_json::{Value, json};
    use std::path::Path;

    pub fn spec(kind: &str) -> Spec {
        spec_on(kind, "kubernetes")
    }

    pub fn spec_on(kind: &str, provider: &str) -> Spec {
        serde_json::from_value(json!({
            "layout": 1, "kind": kind, "name": NAME, "owner": OWNER,
            "generation": "0123456789abcdef0123456789abcdef",
            "settings": {
                "runtime": {"provider": provider},
                "endpoint": "https://127.0.0.1:17671",
                "kubernetes": {
                    "kubeconfig": {"env": "TEST_CLUSTER_CONFIG"}, "context": "selected", "namespace": "agents",
                    "authentication": {"profile": "development"}
                }
            }
        }))
        .unwrap()
    }

    /// A cluster ready to host a gateway: kube-system, the default StorageClass
    /// and the Agent Sandbox CRD and controller.
    pub fn cluster() -> Objects {
        let objects = Objects::default();
        objects.insert(json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kube-system", "uid": "system-1"}}));
        objects.insert(json!({"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
            "metadata": {"name": "standard", "annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}));
        objects.insert(
            json!({"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
            "metadata": {"name": "sandboxes.agents.x-k8s.io"}}),
        );
        objects.insert(json!({"apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": "agent-sandbox-controller", "namespace": "agent-sandbox-system"},
            "status": {"availableReplicas": 1}}));
        objects
    }

    /// Add the ready gateway StatefulSet that a Helm release would leave.
    pub fn ready_gateway(objects: &Objects) {
        objects.insert(json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
            "metadata": {"name": NAME, "namespace": "agents", "uid": "gateway-uid", "generation": 1,
                "labels": {"app.kubernetes.io/instance": NAME},
                "annotations": {"meta.helm.sh/release-name": NAME, "meta.helm.sh/release-namespace": "agents"}},
            "status": {"readyReplicas": 1, "observedGeneration": 1}}));
    }

    /// Replace the annotations of the `agents` Namespace, as OpenShift does when
    /// it assigns the UID and group ranges.
    pub fn annotate_namespace(objects: &Objects, annotations: Value) {
        let mut namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
        namespace["metadata"]["annotations"] = annotations;
        objects.insert(namespace);
    }

    /// Operations over `client`, with `state` as the state directory (the receipt
    /// is `state/receipt.json`) and a short OpenShift wait so a cluster without
    /// ranges fails fast. The receipt binds the cluster by its server address, so
    /// a later run over the same state directory must pass the first run's
    /// `server`; with another address it fails with `BindingMismatch` before it
    /// reaches anything under test.
    pub fn operations(client: kube::Client, server: &str, state: &Path) -> Operations {
        Operations {
            client,
            server: server.to_owned(),
            state: state.to_owned(),
            openshift_wait: std::time::Duration::from_millis(50),
        }
    }

    /// One public call of `Operations`.
    #[derive(Clone, Copy, Debug)]
    pub enum Call {
        Read(&'static str),
        ReadForRemoval(&'static str),
        Ensure(&'static str),
        Remove(&'static str),
        Connect,
    }

    /// Make `call` against specs for `provider`. `Connect` uses a free loopback
    /// port as the gateway endpoint.
    pub async fn run(operations: &Operations, provider: &str, call: Call) -> Result<(), Error> {
        let spec = |kind| spec_on(kind, provider);
        match call {
            Call::Read(kind) => operations.read(&spec(kind), None).await.map(drop)?,
            Call::ReadForRemoval(kind) => operations
                .read_for_removal(&spec(kind), None)
                .await
                .map(drop)?,
            Call::Ensure(kind) => operations.ensure(&spec(kind), None).await.map(drop)?,
            Call::Remove(kind) => operations.remove(&spec(kind), None).await?,
            Call::Connect => {
                let port = std::net::TcpListener::bind("127.0.0.1:0")
                    .unwrap()
                    .local_addr()
                    .unwrap()
                    .port();
                let mut gateway = spec(GATEWAY_KIND);
                gateway.settings.endpoint = format!("https://127.0.0.1:{port}");
                operations.connect(&gateway).await.map(drop)?
            }
        }
        Ok(())
    }

    /// Panic unless `result` is an observation failure of one of the `accepted` classes.
    pub fn assert_class(result: &Result<(), Error>, accepted: &[ObservationError], context: &str) {
        assert!(
            matches!(result, Err(Error::Observation(found)) if accepted.contains(found)),
            "{context}: expected one of {accepted:?}, got {result:?}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::{
        api::{GetParams, PostParams},
        core::Request,
    };
    use serde_json::json;

    fn namespace(name: &str) -> Value {
        json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": name}})
    }

    async fn get(server: &FaultServer, name: &str) -> Result<Value, kube::Error> {
        let request = Request::new("/api/v1/namespaces").get(name, &GetParams::default());
        server.client().request(request.unwrap()).await
    }

    async fn create(server: &FaultServer, name: &str) -> Result<Value, kube::Error> {
        let body = serde_json::to_vec(&namespace(name)).unwrap();
        let request = Request::new("/api/v1/namespaces").create(&PostParams::default(), body);
        server.client().request(request.unwrap()).await
    }

    #[tokio::test]
    async fn a_faulted_request_is_logged_and_counted_and_answered_with_its_status() {
        let objects = Objects::default();
        objects.insert(namespace("present"));
        let server = serve(&objects, |_, path, _| {
            path.ends_with("/present").then_some(Fault::Status(403))
        })
        .await;
        let error = get(&server, "present").await.unwrap_err();
        assert!(
            matches!(&error, kube::Error::Api(status) if status.code == 403),
            "a faulted GET answered {error:?}"
        );
        let expected = [("GET".to_owned(), "/api/v1/namespaces/present".to_owned())];
        assert_eq!(server.requests(), expected);
        assert_eq!(server.faults_fired(), 1);
        assert!(server.mutations().is_empty());
    }

    #[tokio::test]
    async fn an_unfaulted_request_reaches_the_objects_and_is_logged() {
        let objects = Objects::default();
        objects.insert(namespace("present"));
        let server = serve(&objects, |_, _, _| None).await;
        let found = get(&server, "present").await.unwrap();
        assert_eq!(found["metadata"]["name"], "present");
        assert_eq!(server.requests().len(), 1);
        assert_eq!(server.faults_fired(), 0);
    }

    #[test]
    fn an_unchanged_cluster_and_state_directory_pass_the_check() {
        let objects = Objects::default();
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("receipt.json"), b"{}").unwrap();
        let snapshot = Snapshot::capture(&objects, directory.path());
        snapshot.assert_unchanged(&objects, directory.path(), "nothing happened");
    }

    #[test]
    #[should_panic(expected = "after a write: object \"/api/v1/namespaces/late\" changed")]
    fn an_object_written_after_the_snapshot_fails_the_check() {
        let objects = Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let snapshot = Snapshot::capture(&objects, directory.path());
        objects.insert(namespace("late"));
        snapshot.assert_unchanged(&objects, directory.path(), "after a write");
    }

    #[test]
    #[should_panic(expected = "after a write: state file \"receipt.json\" changed")]
    fn a_state_file_written_after_the_snapshot_fails_the_check() {
        let objects = Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let snapshot = Snapshot::capture(&objects, directory.path());
        std::fs::write(directory.path().join("receipt.json"), b"{}").unwrap();
        snapshot.assert_unchanged(&objects, directory.path(), "after a write");
    }

    #[tokio::test]
    async fn a_lost_create_response_stores_the_object_and_shows_the_client_a_connection_error() {
        let objects = Objects::default();
        let server = serve(&objects, |method, _, _| {
            (method == "POST").then_some(Fault::CommitThenDrop)
        })
        .await;
        let error = create(&server, "created").await.unwrap_err();
        assert!(
            !matches!(error, kube::Error::Api(_)),
            "a dropped response was reported as {error:?}"
        );
        assert!(objects.get("v1", "Namespace", "", "created").is_some());
        assert_eq!(server.faults_fired(), 1);
        assert_eq!(server.mutations().len(), 1);
    }

    #[tokio::test]
    async fn a_status_or_dropped_fault_on_a_create_stores_nothing_but_counts_as_a_write() {
        for fault in [Fault::Status(500), Fault::Dropped] {
            let objects = Objects::default();
            let server = serve(&objects, move |method, _, _| {
                (method == "POST").then_some(fault)
            })
            .await;
            create(&server, "refused").await.unwrap_err();
            assert_eq!(objects.len(), 0, "{fault:?} applied the create");
            assert_eq!(server.mutations().len(), 1, "{fault:?}");
        }
    }

    #[tokio::test]
    async fn an_omitted_uid_fault_stores_the_object_and_answers_without_its_uid() {
        let objects = Objects::default();
        let server = serve(&objects, |method, _, _| {
            (method == "POST").then_some(Fault::CommitThenOmitUid)
        })
        .await;
        let reply = create(&server, "created").await.unwrap();
        assert!(reply["metadata"].get("uid").is_none(), "{reply}");
        let stored = objects.get("v1", "Namespace", "", "created").unwrap();
        assert!(stored["metadata"]["uid"].is_string(), "{stored}");
    }
}
