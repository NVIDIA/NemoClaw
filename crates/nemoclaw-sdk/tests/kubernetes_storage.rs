// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Storage install: the namespace, prerequisite check and credential key.

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
const IDENTITY_PATH: &str = "/api/v1/namespaces/kube-system";
const STORAGE_CLASSES_PATH: &str = "/apis/storage.k8s.io/v1/storageclasses";

/// A cluster with kube-system, one default StorageClass, and optionally the
/// Agent Sandbox controller already installed.
fn cluster(agent_sandbox: bool) -> Objects {
    let objects = Objects::default();
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kube-system", "uid": "system-1"}}));
    objects.insert(json!({"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
        "metadata": {"name": "standard", "annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}));
    if agent_sandbox {
        objects.insert(
            json!({"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
            "metadata": {"name": "sandboxes.agents.x-k8s.io"}}),
        );
        objects.insert(json!({"apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": "agent-sandbox-controller", "namespace": "agent-sandbox-system"},
            "status": {"availableReplicas": 1}}));
    }
    objects
}

fn storage(directory: &std::path::Path) -> Storage {
    Storage {
        directory: directory.into(),
        server: "https://cluster.example:6443".into(),
        namespace: "agents".into(),
        name: "nc-0123456789abcdef-gateway".into(),
        owner: OWNER.into(),
    }
}

#[tokio::test]
async fn storage_creates_the_namespace_and_key_and_records_them() {
    let objects = cluster(true);
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    let receipt = ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    assert!(receipt.storage_ready);
    assert_eq!(receipt.cluster.as_ref().unwrap().system_uid, "system-1");
    let kinds: Vec<_> = receipt
        .objects
        .iter()
        .map(|owned| owned.kind.as_str())
        .collect();
    assert_eq!(kinds, ["Namespace", "Secret"]);
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
async fn an_existing_namespace_is_not_taken_over() {
    let objects = cluster(true);
    objects
        .insert(json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "agents"}}));
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    assert!(matches!(
        ensure_storage(&cluster, &storage(directory.path())).await,
        Err(ObservationError::BindingMismatch)
    ));
}

#[tokio::test]
async fn storage_requires_agent_sandbox_to_be_installed() {
    let fixture = cluster(false).serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    assert!(matches!(
        ensure_storage(&cluster, &storage(directory.path())).await,
        Err(ObservationError::Backend(_))
    ));
}

#[tokio::test]
async fn storage_needs_exactly_one_default_storage_class() {
    let objects = cluster(true);
    objects.insert(json!({"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
        "metadata": {"name": "fast", "annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}));
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    assert!(matches!(
        ensure_storage(&cluster, &storage(directory.path())).await,
        Err(ObservationError::Backend(_))
    ));
}

#[tokio::test]
async fn a_rebuilt_cluster_at_the_same_address_is_refused() {
    let objects = cluster(true);
    let fixture = objects.serve().await;
    let directory = tempfile::tempdir().unwrap();
    let cluster = Cluster::new(client(&fixture), OWNER, "generation-1");
    ensure_storage(&cluster, &storage(directory.path()))
        .await
        .unwrap();
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kube-system", "uid": "system-2"}}));
    assert!(matches!(
        ensure_storage(&cluster, &storage(directory.path())).await,
        Err(ObservationError::BindingMismatch)
    ));
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
/// unchanged and no write sent. The identity read comes before storage binds
/// the cluster, so a failure there must leave no receipt.
async fn apply_with_fault(
    faulted: &'static str,
    fault: Fault,
) -> Result<Receipt, ObservationError> {
    let objects = cluster(true);
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
    if faulted == IDENTITY_PATH {
        assert_eq!(
            Receipt::load(directory.path(), OWNER, "nc-0123456789abcdef-gateway").unwrap(),
            None,
            "a failed identity read left a receipt"
        );
    }
    result
}

#[tokio::test]
async fn an_unauthorized_cluster_identity_read_is_an_authentication_failure() {
    assert_eq!(
        apply_with_fault(IDENTITY_PATH, Fault::Status(401)).await,
        Err(ObservationError::Authentication)
    );
}

#[tokio::test]
async fn a_forbidden_cluster_identity_read_is_a_permission_failure() {
    assert_eq!(
        apply_with_fault(IDENTITY_PATH, Fault::Status(403)).await,
        Err(ObservationError::Permission)
    );
}

#[tokio::test]
async fn a_dropped_connection_during_the_cluster_identity_read_is_a_transport_failure() {
    assert_eq!(
        apply_with_fault(IDENTITY_PATH, Fault::Dropped).await,
        Err(ObservationError::Transport)
    );
}

#[tokio::test]
async fn an_unauthorized_storage_class_list_is_an_authentication_failure() {
    assert_eq!(
        apply_with_fault(STORAGE_CLASSES_PATH, Fault::Status(401)).await,
        Err(ObservationError::Authentication)
    );
}

#[tokio::test]
async fn a_forbidden_storage_class_list_is_a_permission_failure() {
    assert_eq!(
        apply_with_fault(STORAGE_CLASSES_PATH, Fault::Status(403)).await,
        Err(ObservationError::Permission)
    );
}

#[tokio::test]
async fn a_dropped_connection_during_the_storage_class_list_is_a_transport_failure() {
    assert_eq!(
        apply_with_fault(STORAGE_CLASSES_PATH, Fault::Dropped).await,
        Err(ObservationError::Transport)
    );
}

/// The in-memory API reports an absent object as missing, even one whose name
/// ends in `s` like a collection's.
#[tokio::test]
async fn the_in_memory_api_reports_absent_objects_as_missing() {
    use nemoclaw_sdk::kubernetes::cluster::Owned;
    let objects = cluster(true);
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
