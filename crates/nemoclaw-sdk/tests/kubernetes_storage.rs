// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Storage install: binding the namespace and creating the credential key.

use crate::{kube_api::Objects, kube_client::client};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{
        cluster::Cluster,
        receipt::Receipt,
        storage::{Storage, ensure_storage},
    },
};
use serde_json::json;
use std::sync::{Arc, Mutex};

const OWNER: &str = "00000000-0000-4000-8000-000000000001";
const NAMESPACE_PATH: &str = "/api/v1/namespaces/agents";

fn storage(directory: &std::path::Path) -> Storage {
    Storage {
        directory: directory.into(),
        namespace: "agents".into(),
        name: "nc-0123456789abcdef-gateway".into(),
        owner: OWNER.into(),
    }
}

#[tokio::test]
async fn storage_creates_the_namespace_and_key_and_records_them() {
    let objects = Objects::default();
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    let receipt = ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    assert!(receipt.storage_ready);
    let namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
    assert_eq!(
        receipt.namespace.as_ref().unwrap().uid,
        namespace["metadata"]["uid"].as_str().unwrap()
    );
    let kinds: Vec<_> = receipt
        .objects
        .iter()
        .map(|owned| owned.kind.as_str())
        .collect();
    assert_eq!(kinds, ["Secret"]);
    let key = objects
        .get("v1", "Secret", "agents", "nc-0123456789abcdef-gateway-kek")
        .unwrap();
    // The gateway reads base64 text holding a 32-byte key from the Secret.
    use base64::{Engine, engine::general_purpose::STANDARD};
    let text = STANDARD
        .decode(key["data"]["key-encryption-key"].as_str().unwrap())
        .unwrap();
    assert_eq!(STANDARD.decode(text).unwrap().len(), 32);
    assert_eq!(
        Receipt::load(directory.path(), OWNER, "nc-0123456789abcdef-gateway").unwrap(),
        Some(receipt)
    );
    // A second apply finds everything in place and creates nothing new.
    let count = objects.len();
    ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    assert_eq!(objects.len(), count);
}

#[tokio::test]
async fn a_replaced_key_secret_is_refused_by_name() {
    let objects = Objects::default();
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    let mut key = objects
        .get("v1", "Secret", "agents", "nc-0123456789abcdef-gateway-kek")
        .unwrap();
    key["metadata"]["uid"] = json!("replacement");
    objects.insert(key);
    let error = ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("Secret agents/nc-0123456789abcdef-gateway-kek was replaced"),
        "{message}"
    );
}

/// How the API server fails the request under test: with an HTTP status, or
/// by closing the connection without answering.
#[derive(Clone, Copy)]
enum Fault {
    Status(u16),
    Dropped,
}

/// Apply storage against a cluster that fails every GET of `faulted` as
/// `fault` and answers everything else normally. Returns what storage
/// reports and checks what a failed read must leave behind: the cluster
/// unchanged and no write sent. The namespace read comes before storage binds
/// the namespace, so a failure there must leave no receipt.
async fn apply_with_fault(
    faulted: &'static str,
    fault: Fault,
) -> Result<Receipt, ObservationError> {
    let objects = Objects::default();
    let before = objects.0.lock().unwrap().clone();
    let requests = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let (served, log) = (objects.clone(), requests.clone());
    let fixture = crate::transport::Fixture::start_tcp(move |request| {
        // The kube client appends a query string to every path.
        let path = request
            .path
            .split('?')
            .next()
            .unwrap_or_default()
            .to_owned();
        log.lock()
            .unwrap()
            .push((request.method.clone(), path.clone()));
        if request.method == "GET" && path == faulted {
            return match fault {
                Fault::Status(code) => Some((
                    code,
                    json!({"apiVersion": "v1", "kind": "Status", "status": "Failure",
                        "code": code, "reason": "Denied"})
                    .to_string()
                    .into_bytes(),
                )),
                Fault::Dropped => None,
            };
        }
        served.answer(&request.method, &request.path, &request.body)
    })
    .await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    let result = ensure_storage(&cluster, &storage(directory.path())).await;
    let requests = requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .any(|(method, path)| method == "GET" && path == faulted),
        "the faulted request was never made"
    );
    assert!(
        requests.iter().all(|(method, _)| method == "GET"),
        "a failed read was followed by a write"
    );
    assert_eq!(*objects.0.lock().unwrap(), before, "the cluster changed");
    assert_eq!(
        Receipt::load(directory.path(), OWNER, "nc-0123456789abcdef-gateway").unwrap(),
        None,
        "a failed namespace read left a receipt"
    );
    result
}

/// A failed namespace read is reported by its class.
#[tokio::test]
async fn a_failed_namespace_read_is_reported_by_class() {
    for (fault, error) in [
        (Fault::Status(401), ObservationError::Authentication),
        (Fault::Status(403), ObservationError::Permission),
        (Fault::Dropped, ObservationError::Transport),
    ] {
        assert_eq!(apply_with_fault(NAMESPACE_PATH, fault).await, Err(error));
    }
}

/// The in-memory API reports an absent object as missing, even one whose name
/// ends in `s` like a collection's.
#[tokio::test]
async fn the_in_memory_api_reports_absent_objects_as_missing() {
    use nemoclaw_sdk::kubernetes::cluster::Owned;
    let objects = Objects::default();
    let fixture = objects.serve().await;
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    for (kind, namespace, name) in [
        ("Namespace", "", "agents"),
        ("Secret", "agents", "credentials"),
    ] {
        let owned = Owned {
            api_version: "v1".into(),
            kind: kind.into(),
            namespace: namespace.into(),
            name: name.into(),
            uid: String::new(),
        };
        assert!(
            cluster.get(&owned).await.unwrap().is_none(),
            "{kind} {name}"
        );
    }
}

/// A namespace and pull Secret an operator created before the first apply.
pub(crate) fn operator_namespace(objects: &Objects, labels: serde_json::Value) {
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace",
        "metadata": {"name": "agents", "uid": "operator-ns", "labels": labels}}));
    objects.insert(json!({"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/dockerconfigjson",
        "metadata": {"name": "registry-credentials", "namespace": "agents", "uid": "operator-secret"},
        "data": {".dockerconfigjson": "e30="}}));
}

#[tokio::test]
async fn an_existing_namespace_is_bound_by_uid_and_left_unchanged() {
    let objects = Objects::default();
    operator_namespace(&objects, json!({"team": "agents"}));
    let namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
    let secret = objects
        .get("v1", "Secret", "agents", "registry-credentials")
        .unwrap();
    // No kube-system, Agent Sandbox or StorageClass objects: storage reads none of them.
    let server = crate::kube_faults::serve(&objects, |_, path, _| {
        [
            "/api/v1/namespaces/kube-system",
            "/apis/apiextensions.k8s.io/",
            "/apis/storage.k8s.io/",
            "/apis/apps/v1/namespaces/agent-sandbox-system",
        ]
        .iter()
        .any(|prefix| path.starts_with(prefix))
        .then_some(crate::kube_faults::Fault::Status(403))
    })
    .await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(server.client(), OWNER, "generation-1");
    let receipt = ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    assert!(receipt.storage_ready);
    assert_eq!(server.faults_fired(), 0, "{:?}", server.requests());
    assert_eq!(
        server.mutations(),
        [(
            "POST".to_owned(),
            "/api/v1/namespaces/agents/secrets".to_owned()
        )]
    );
    assert_eq!(
        objects.get("v1", "Namespace", "", "agents").unwrap(),
        namespace
    );
    assert_eq!(
        objects
            .get("v1", "Secret", "agents", "registry-credentials")
            .unwrap(),
        secret
    );
    // A second apply finds the same namespace and creates nothing new.
    let count = objects.len();
    ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    assert_eq!(objects.len(), count);
}

#[tokio::test]
async fn a_bound_namespace_that_is_deleted_or_recreated_stops_storage() {
    for created in [false, true] {
        for recreated in [false, true] {
            let objects = Objects::default();
            if !created {
                operator_namespace(&objects, json!({}));
            }
            let fixture = objects.serve().await;
            let directory = tempfile::tempdir().unwrap();
            let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
            ensure_storage(&cluster, &storage(directory.path()))
                .await
                .unwrap();
            let receipt = std::fs::read(directory.path().join("receipt.json")).unwrap();
            let mut namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
            objects
                .0
                .lock()
                .unwrap()
                .retain(|_, object| object["kind"] != "Namespace");
            if recreated {
                namespace["metadata"]["uid"] = json!("recreated");
                objects.insert(namespace);
            }
            let count = objects.len();
            let message = ensure_storage(&cluster, &storage(directory.path()))
                .await
                .unwrap_err()
                .to_string();
            let expected = if recreated {
                "was replaced"
            } else {
                "is missing"
            };
            assert!(
                message.contains(&format!("Namespace agents {expected}")),
                "created {created}, recreated {recreated}: {message}"
            );
            assert_eq!(objects.len(), count, "nothing was created");
            assert_eq!(
                std::fs::read(directory.path().join("receipt.json")).unwrap(),
                receipt,
                "the receipt is unchanged"
            );
        }
    }
}

#[tokio::test]
async fn a_namespace_another_deployment_owns_is_refused() {
    let objects = Objects::default();
    operator_namespace(
        &objects,
        json!({"nemoclaw.nvidia.com/uid": "00000000-0000-4000-8000-000000000002"}),
    );
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    let count = objects.len();
    let message = ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        message.contains("Namespace agents belongs to another NemoClaw deployment"),
        "{message}"
    );
    assert_eq!(objects.len(), count);
}

#[tokio::test]
async fn a_namespace_being_deleted_is_refused_and_nothing_is_recorded() {
    let objects = Objects::default();
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace",
        "metadata": {"name": "agents", "uid": "operator-ns",
            "deletionTimestamp": "2026-10-28T00:00:00Z", "finalizers": ["kubernetes"]}}));
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    let count = objects.len();
    let message = ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap_err()
        .to_string();
    assert!(
        message.contains("Namespace agents is being deleted"),
        "{message}"
    );
    assert_eq!(objects.len(), count);
    assert_eq!(
        Receipt::load(directory.path(), OWNER, "nc-0123456789abcdef-gateway").unwrap(),
        None
    );
}

#[tokio::test]
async fn storage_refuses_a_namespace_other_than_the_one_it_bound() {
    let objects = Objects::default();
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    // Another deployment's namespace, which this deployment must never write to.
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace",
        "metadata": {"name": "other-agents",
            "labels": {"nemoclaw.nvidia.com/uid": "00000000-0000-4000-8000-000000000002"}}}));
    let count = objects.len();
    let mut other = storage(directory.path());
    other.namespace = "other-agents".into();
    let message = ensure_storage(&cluster, &other)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        message
            .contains("Namespace agents is bound; gateway.kubernetes.namespace names other-agents"),
        "{message}"
    );
    assert_eq!(objects.len(), count, "nothing was created in other-agents");
}
