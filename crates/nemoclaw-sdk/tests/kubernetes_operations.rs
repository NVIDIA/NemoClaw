// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The operations the provider calls for the two Kubernetes resources.
#![cfg(unix)]

use crate::kube_api::{Objects, client};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{
        GATEWAY_KIND, STORAGE_KIND, Spec,
        operations::{Operations, Response},
    },
};
use serde_json::json;
use std::path::{Path, PathBuf};

const OWNER: &str = "00000000-0000-4000-8000-000000000001";
const NAME: &str = "nc-0123456789abcdef-gateway";

fn spec(kind: &str) -> Spec {
    serde_json::from_value(json!({
        "layout": 1, "kind": kind, "name": NAME, "owner": OWNER,
        "generation": "0123456789abcdef0123456789abcdef",
        "settings": {
            "endpoint": "https://127.0.0.1:17671",
            "kubernetes": {
                "kubeconfig": {"env": "TEST_CLUSTER_CONFIG"}, "context": "selected", "namespace": "agents",
                "prerequisites": {"agentSandbox": {"management": "existing"}},
                "authentication": {"profile": "development"}
            }
        }
    }))
    .unwrap()
}

/// A cluster ready to host a gateway.
fn cluster() -> Objects {
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

/// A fake helm that, on install, creates a ready gateway StatefulSet in the
/// fake cluster through `objects`.
fn helm(directory: &Path) -> PathBuf {
    let helm = directory.join("helm");
    std::fs::write(
        &helm,
        format!(
            "#!/bin/sh\necho \"$1\" >> {}/helm.log\n",
            directory.display()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&helm, std::fs::Permissions::from_mode(0o700)).unwrap();
    helm
}

fn ready_gateway(objects: &Objects) {
    objects.insert(json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": NAME, "namespace": "agents", "uid": "gateway-uid", "generation": 1},
        "status": {"readyReplicas": 1, "observedGeneration": 1}}));
}

async fn operations(
    objects: &Objects,
    directory: &Path,
) -> (crate::transport::Fixture, Operations) {
    let fixture = objects.serve().await;
    let operations = Operations {
        client: client(&fixture),
        server: fixture.endpoint.clone(),
        helm: helm(directory),
        kubeconfig: directory.join("kubeconfig"),
        state: directory.join("state"),
    };
    (fixture, operations)
}

#[tokio::test]
async fn nothing_exists_before_the_first_apply() {
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&cluster(), directory.path()).await;
    for kind in [STORAGE_KIND, GATEWAY_KIND] {
        let response = operations.read(&spec(kind), None).await.unwrap();
        assert_eq!(response, Response::default(), "{kind}");
    }
}

#[tokio::test]
async fn ensuring_storage_then_gateway_reports_both_running() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    let storage = operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    assert_eq!(storage.running, Some(true));
    let storage_id = storage.id.clone().unwrap();
    // The gateway needs its storage first.
    ready_gateway(&objects);
    let gateway = operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(gateway.running, Some(true));
    assert_eq!(gateway.id.as_deref(), Some("gateway-uid"));
    assert_eq!(
        std::fs::read_to_string(directory.path().join("helm.log")).unwrap(),
        "upgrade\n"
    );
    // The development issuer runs beside the gateway, serving public documents only.
    let issuer = format!("{NAME}-oidc");
    let documents = objects.get("v1", "ConfigMap", "agents", &issuer).unwrap();
    let jwks: serde_json::Value =
        serde_json::from_str(documents["data"]["jwks"].as_str().unwrap()).unwrap();
    assert_eq!(jwks["keys"][0]["crv"], "Ed25519");
    assert!(
        jwks["keys"][0].get("d").is_none(),
        "the private key must stay local"
    );
    for (api_version, kind) in [
        ("apps/v1", "Deployment"),
        ("v1", "Service"),
        ("networking.k8s.io/v1", "NetworkPolicy"),
    ] {
        assert!(
            objects.get(api_version, kind, "agents", &issuer).is_some(),
            "{kind}"
        );
    }
    let policy = objects
        .get("networking.k8s.io/v1", "NetworkPolicy", "agents", &issuer)
        .unwrap();
    assert_eq!(policy["spec"]["egress"], json!([]));
    // A later read sees the same identities.
    let read = operations
        .read(&spec(STORAGE_KIND), Some(&storage_id))
        .await
        .unwrap();
    assert_eq!(read.id.as_deref(), Some(storage_id.as_str()));
    let read = operations
        .read(&spec(GATEWAY_KIND), Some("gateway-uid"))
        .await
        .unwrap();
    assert_eq!(read.running, Some(true));
}

#[tokio::test]
async fn the_gateway_waits_for_its_storage() {
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&cluster(), directory.path()).await;
    assert!(matches!(
        operations.ensure(&spec(GATEWAY_KIND), None).await,
        Err(ObservationError::Incomplete)
    ));
    assert!(!directory.path().join("helm.log").exists());
}

#[tokio::test]
async fn a_replaced_gateway_is_a_binding_mismatch() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    ready_gateway(&objects);
    operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    objects.insert(json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": NAME, "namespace": "agents", "uid": "someone-else"},
        "status": {"readyReplicas": 1}}));
    assert!(matches!(
        operations
            .read(&spec(GATEWAY_KIND), Some("gateway-uid"))
            .await,
        Err(ObservationError::BindingMismatch)
    ));
}

#[tokio::test]
async fn removing_the_gateway_uninstalls_it_and_keeps_storage() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    let storage = operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    ready_gateway(&objects);
    operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    // The fake helm does not delete the StatefulSet; the cluster would.
    objects
        .0
        .lock()
        .unwrap()
        .retain(|path, _| !path.contains("/statefulsets/"));
    operations
        .remove(&spec(GATEWAY_KIND), Some("gateway-uid"))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(directory.path().join("helm.log")).unwrap(),
        "upgrade\nuninstall\n"
    );
    let gateway = operations.read(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(gateway.id, None);
    let kept = operations
        .read(&spec(STORAGE_KIND), storage.id.as_deref())
        .await
        .unwrap();
    assert_eq!(kept.id, storage.id);
    assert!(objects.get("v1", "Namespace", "", "agents").is_some());
    // The issuer is removed with the release.
    let issuer = format!("{NAME}-oidc");
    assert!(
        objects
            .get("apps/v1", "Deployment", "agents", &issuer)
            .is_none()
    );
    assert!(
        objects
            .get("v1", "ConfigMap", "agents", &format!("{issuer}-ca"))
            .is_none()
    );
}
