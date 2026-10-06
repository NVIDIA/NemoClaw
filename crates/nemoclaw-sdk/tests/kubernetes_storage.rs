// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Storage install: the namespace, prerequisite check and credential key.

use crate::kube_api::{Objects, client};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{
        cluster::Cluster,
        receipt::{Prerequisites, Receipt},
        storage::{Storage, ensure_storage},
    },
};
use serde_json::json;

const OWNER: &str = "00000000-0000-4000-8000-000000000001";

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
        manage_prerequisites: false,
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
    assert_eq!(receipt.prerequisites, Some(Prerequisites::Existing));
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
async fn missing_prerequisites_fail_when_the_platform_owns_them() {
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
