// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Kubernetes preparation and observation around the native Helm release.
#![cfg(unix)]

use crate::kube_api::{Objects, client};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{
        AUTH_KIND, GATEWAY_KIND, STORAGE_KIND, Spec,
        operations::{Operations, Response},
        receipt::Receipt,
    },
};
use serde_json::json;
use std::path::Path;

const OWNER: &str = "00000000-0000-4000-8000-000000000001";
const NAME: &str = "nc-0123456789abcdef-gateway";

fn spec(kind: &str) -> Spec {
    spec_on(kind, "kubernetes")
}

fn spec_on(kind: &str, provider: &str) -> Spec {
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

fn ready_gateway(objects: &Objects) {
    objects.insert(json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": NAME, "namespace": "agents", "uid": "gateway-uid", "generation": 1,
            "labels": {"app.kubernetes.io/instance": NAME},
            "annotations": {"meta.helm.sh/release-name": NAME, "meta.helm.sh/release-namespace": "agents"}},
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
        state: directory.join("state"),
        // Short, so a cluster without OpenShift ranges fails fast.
        openshift_wait: std::time::Duration::from_millis(50),
    };
    (fixture, operations)
}

#[tokio::test]
async fn nothing_exists_before_the_first_apply() {
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&cluster(), directory.path()).await;
    for kind in [STORAGE_KIND, AUTH_KIND, GATEWAY_KIND] {
        let response = operations.read(&spec(kind), None).await.unwrap();
        assert_eq!(response, Response::default(), "{kind}");
    }
}

#[tokio::test]
async fn observing_an_installed_gateway_does_not_invoke_helm() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    ready_gateway(&objects);
    let before = objects.0.lock().unwrap().clone();
    operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(*objects.0.lock().unwrap(), before);
    assert!(
        !directory.path().join("helm.log").exists(),
        "the Helm provider owns release installation"
    );
}

#[tokio::test]
async fn storage_and_authentication_are_prepared_before_the_gateway_is_observed() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    let storage = operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    assert_eq!(storage.running, Some(true));
    let storage_id = storage.id.clone().unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    assert_eq!(auth.running, Some(true));
    assert!(
        objects
            .get("apps/v1", "StatefulSet", "agents", NAME)
            .is_none()
    );
    ready_gateway(&objects);
    let gateway = operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(gateway.running, Some(true));
    assert_eq!(gateway.id.as_deref(), Some("gateway-uid"));
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

/// The namespace annotations OpenShift writes when it creates a project.
fn assign_openshift_range(objects: &Objects) {
    let mut namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
    namespace["metadata"]["annotations"] = json!({
        "openshift.io/sa.scc.uid-range": "1000680000/10000",
        "openshift.io/sa.scc.supplemental-groups": "1000690000/10000",
    });
    objects.insert(namespace);
}

#[tokio::test]
async fn on_openshift_authentication_exports_the_retained_namespace_identity() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations
        .ensure(&spec_on(STORAGE_KIND, "openshift"), None)
        .await
        .unwrap();
    assign_openshift_range(&objects);
    let response = operations
        .ensure(&spec_on(AUTH_KIND, "openshift"), None)
        .await
        .unwrap();
    let values: serde_json::Value =
        serde_json::from_str(response.gateway_values.as_deref().unwrap()).unwrap();
    assert_eq!(
        values,
        json!({
            "securityContext": {"runAsUser": 1_000_680_000},
            "podSecurityContext": {"fsGroup": 1_000_690_000},
        }),
        "only the numeric namespace identity may enter Helm through authentication state"
    );
    assert_eq!(response.running, Some(true));
    let receipt = Receipt::load(&operations.state, OWNER, NAME)
        .unwrap()
        .unwrap();
    let identity = receipt.namespace_identity.unwrap();
    assert_eq!(identity.user, 1_000_680_000);
    assert_eq!(identity.group, 1_000_690_000);
    let read = operations
        .read(&spec_on(AUTH_KIND, "openshift"), response.id.as_deref())
        .await
        .unwrap();
    assert_eq!(read.gateway_values, response.gateway_values);
}

#[tokio::test]
async fn openshift_waits_for_namespace_annotations_before_writing_issuer_objects() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, mut operations) = operations(&objects, directory.path()).await;
    operations.openshift_wait = std::time::Duration::from_secs(1);
    operations
        .ensure(&spec_on(STORAGE_KIND, "openshift"), None)
        .await
        .unwrap();
    let before = objects.0.lock().unwrap().clone();
    let spec = spec_on(AUTH_KIND, "openshift");
    let (response, ()) = tokio::join!(operations.ensure(&spec, None), async {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert_eq!(*objects.0.lock().unwrap(), before);
        assign_openshift_range(&objects);
    });
    let response = response.unwrap();
    assert_eq!(response.running, Some(true));
    let values: serde_json::Value =
        serde_json::from_str(response.gateway_values.as_deref().unwrap()).unwrap();
    assert_eq!(values["securityContext"]["runAsUser"], 1_000_680_000);
}

#[tokio::test]
async fn a_legacy_openshift_receipt_is_incomplete_until_its_identity_is_recorded() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations
        .ensure(&spec_on(STORAGE_KIND, "openshift"), None)
        .await
        .unwrap();
    assign_openshift_range(&objects);
    let initial = operations
        .ensure(&spec_on(AUTH_KIND, "openshift"), None)
        .await
        .unwrap();
    let mut receipt = Receipt::load(&operations.state, OWNER, NAME)
        .unwrap()
        .unwrap();
    receipt.namespace_identity = None;
    receipt.save(&operations.state).unwrap();
    let legacy = operations
        .read(&spec_on(AUTH_KIND, "openshift"), initial.id.as_deref())
        .await
        .unwrap();
    assert_eq!(legacy.running, Some(false));
    assert_eq!(legacy.gateway_values.as_deref(), Some("{}"));
    let restored = operations
        .ensure(&spec_on(AUTH_KIND, "openshift"), initial.id.as_deref())
        .await
        .unwrap();
    assert_eq!(restored.running, Some(true));
    assert_eq!(restored.gateway_values, initial.gateway_values);
    assert!(
        Receipt::load(&operations.state, OWNER, NAME)
            .unwrap()
            .unwrap()
            .namespace_identity
            .is_some()
    );
}

#[tokio::test]
async fn changed_openshift_ranges_block_refresh_but_do_not_block_issuer_removal() {
    for annotations in [
        json!({}),
        json!({"openshift.io/sa.scc.uid-range": "1000700000/10000"}),
        json!({"openshift.io/sa.scc.uid-range": "malformed"}),
    ] {
        let objects = cluster();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path()).await;
        operations
            .ensure(&spec_on(STORAGE_KIND, "openshift"), None)
            .await
            .unwrap();
        assign_openshift_range(&objects);
        let initial = operations
            .ensure(&spec_on(AUTH_KIND, "openshift"), None)
            .await
            .unwrap();
        let mut namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
        namespace["metadata"]["annotations"] = annotations;
        objects.insert(namespace);
        assert!(
            operations
                .read(&spec_on(AUTH_KIND, "openshift"), initial.id.as_deref())
                .await
                .is_err()
        );
        let removing = operations
            .read_for_removal(&spec_on(AUTH_KIND, "openshift"), initial.id.as_deref())
            .await
            .unwrap();
        assert_eq!(removing.gateway_values, initial.gateway_values);
        operations
            .remove(&spec_on(AUTH_KIND, "openshift"), initial.id.as_deref())
            .await
            .unwrap();
        assert_eq!(
            operations
                .read(&spec_on(STORAGE_KIND, "openshift"), None)
                .await
                .unwrap()
                .running,
            Some(true)
        );
        assert!(
            Receipt::load(&operations.state, OWNER, NAME)
                .unwrap()
                .unwrap()
                .namespace_identity
                .is_some()
        );
    }
}

#[tokio::test]
async fn openshift_identity_never_comes_from_a_replacement_namespace() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations
        .ensure(&spec_on(STORAGE_KIND, "openshift"), None)
        .await
        .unwrap();
    assign_openshift_range(&objects);
    let mut namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
    namespace["metadata"]["uid"] = json!("replacement-namespace");
    objects.insert(namespace);
    assert_eq!(
        operations
            .ensure(&spec_on(AUTH_KIND, "openshift"), None)
            .await,
        Err(ObservationError::BindingMismatch)
    );
    assert!(
        Receipt::load(&operations.state, OWNER, NAME)
            .unwrap()
            .unwrap()
            .issuer
            .is_empty()
    );
}

#[tokio::test]
async fn without_openshift_ranges_authentication_stops_before_writing_issuer_objects() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations
        .ensure(&spec_on(STORAGE_KIND, "openshift"), None)
        .await
        .unwrap();
    let before = objects.0.lock().unwrap().clone();
    let error = operations
        .ensure(&spec_on(AUTH_KIND, "openshift"), None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("UID range"), "{error}");
    assert_eq!(
        *objects.0.lock().unwrap(),
        before,
        "only retained storage exists"
    );
    assert_eq!(
        operations
            .read_for_removal(&spec_on(AUTH_KIND, "openshift"), None)
            .await
            .unwrap()
            .id,
        None
    );
}

#[tokio::test]
async fn authentication_and_gateway_observation_require_their_prerequisites() {
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&cluster(), directory.path()).await;
    for kind in [AUTH_KIND, GATEWAY_KIND] {
        assert!(matches!(
            operations.ensure(&spec(kind), None).await,
            Err(ObservationError::Incomplete)
        ));
    }
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
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
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
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
    assert_eq!(
        operations.read(&spec(AUTH_KIND), auth.id.as_deref()).await,
        Err(ObservationError::BindingMismatch),
        "authentication refresh must gate native Helm changes"
    );
    assert_eq!(
        operations
            .read_for_removal(&spec(AUTH_KIND), auth.id.as_deref())
            .await,
        Err(ObservationError::BindingMismatch),
        "teardown also refuses a substituted gateway"
    );
    assert_eq!(
        operations
            .remove(&spec(GATEWAY_KIND), Some("gateway-uid"))
            .await,
        Err(ObservationError::BindingMismatch)
    );
}

#[tokio::test]
async fn a_missing_bound_gateway_blocks_authentication_refresh_before_helm() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    ready_gateway(&objects);
    operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    objects
        .0
        .lock()
        .unwrap()
        .retain(|path, _| !path.contains("/statefulsets/"));
    assert_eq!(
        operations.read(&spec(AUTH_KIND), auth.id.as_deref()).await,
        Err(ObservationError::BindingMismatch)
    );
    assert_eq!(
        operations
            .ensure(&spec(AUTH_KIND), auth.id.as_deref())
            .await,
        Err(ObservationError::BindingMismatch)
    );
    assert_eq!(
        operations
            .read_for_removal(&spec(AUTH_KIND), auth.id.as_deref())
            .await
            .unwrap(),
        auth,
        "interrupted destroy can finish after the release disappeared"
    );
}

#[tokio::test]
async fn an_unready_existing_gateway_keeps_its_identity_and_can_be_observed_again() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    ready_gateway(&objects);
    let mut unready = objects
        .get("apps/v1", "StatefulSet", "agents", NAME)
        .unwrap();
    unready["status"]["readyReplicas"] = json!(0);
    objects.insert(unready);
    let gateway = operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    assert_eq!(gateway.id.as_deref(), Some("gateway-uid"));
    assert_eq!(gateway.running, Some(false));
    assert_eq!(
        operations
            .read(&spec(AUTH_KIND), auth.id.as_deref())
            .await
            .unwrap(),
        auth
    );
    ready_gateway(&objects);
    let recovered = operations
        .ensure(&spec(GATEWAY_KIND), gateway.id.as_deref())
        .await
        .unwrap();
    assert_eq!(recovered.id, gateway.id);
    assert_eq!(recovered.running, Some(true));
}

#[tokio::test]
async fn cleanup_waits_for_helm_and_keeps_storage() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    let storage = operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    ready_gateway(&objects);
    operations.ensure(&spec(GATEWAY_KIND), None).await.unwrap();
    let before = objects.0.lock().unwrap().clone();
    let receipt = Receipt::load(&operations.state, OWNER, NAME)
        .unwrap()
        .unwrap();
    operations
        .remove(&spec(GATEWAY_KIND), Some("gateway-uid"))
        .await
        .unwrap();
    assert_eq!(*objects.0.lock().unwrap(), before);
    assert_eq!(
        Receipt::load(&operations.state, OWNER, NAME).unwrap(),
        Some(receipt)
    );
    assert_eq!(
        operations
            .remove(&spec(AUTH_KIND), auth.id.as_deref())
            .await,
        Err(ObservationError::Incomplete)
    );
    assert_eq!(*objects.0.lock().unwrap(), before);
    // The native Helm provider deletes the release before issuer cleanup.
    objects
        .0
        .lock()
        .unwrap()
        .retain(|path, _| !path.contains("/statefulsets/"));
    operations
        .remove(&spec(AUTH_KIND), auth.id.as_deref())
        .await
        .unwrap();
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

#[tokio::test]
async fn authentication_refuses_replaced_storage_and_issuer_before_changes() {
    for (api, kind, namespace, name) in [
        ("v1", "Namespace", "", "agents".to_owned()),
        ("v1", "Secret", "agents", format!("{NAME}-kek")),
        ("apps/v1", "Deployment", "agents", format!("{NAME}-oidc")),
    ] {
        let objects = cluster();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path()).await;
        operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
        let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
        let mut substituted = objects.get(api, kind, namespace, &name).unwrap();
        substituted["metadata"]["uid"] = json!("replacement-uid");
        objects.insert(substituted);
        let before = objects.0.lock().unwrap().clone();
        let receipt = std::fs::read(operations.state.join("receipt.json")).unwrap();
        assert_eq!(
            operations.read(&spec(AUTH_KIND), auth.id.as_deref()).await,
            Err(ObservationError::BindingMismatch),
            "{kind}"
        );
        assert_eq!(
            operations
                .ensure(&spec(AUTH_KIND), auth.id.as_deref())
                .await,
            Err(ObservationError::BindingMismatch),
            "{kind}"
        );
        assert_eq!(*objects.0.lock().unwrap(), before);
        assert_eq!(
            std::fs::read(operations.state.join("receipt.json")).unwrap(),
            receipt
        );
    }
}

#[tokio::test]
async fn a_missing_recorded_issuer_object_is_not_recreated_or_forgotten() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    let receipt = Receipt::load(&operations.state, OWNER, NAME)
        .unwrap()
        .unwrap();
    let missing = receipt.issuer.last().unwrap();
    let path = format!(
        "{}/{}",
        crate::kube_api::collection(&missing.api_version, &missing.kind, &missing.namespace),
        missing.name
    );
    objects.0.lock().unwrap().remove(&path);
    let before = objects.0.lock().unwrap().clone();
    assert_eq!(
        operations.read(&spec(AUTH_KIND), auth.id.as_deref()).await,
        Err(ObservationError::BindingMismatch)
    );
    assert_eq!(
        operations
            .ensure(&spec(AUTH_KIND), auth.id.as_deref())
            .await,
        Err(ObservationError::BindingMismatch)
    );
    assert_eq!(*objects.0.lock().unwrap(), before);
    assert_eq!(
        Receipt::load(&operations.state, OWNER, NAME).unwrap(),
        Some(receipt)
    );
}

#[tokio::test]
async fn gateway_observation_refuses_an_object_outside_the_helm_release() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    ready_gateway(&objects);
    let original = objects
        .get("apps/v1", "StatefulSet", "agents", NAME)
        .unwrap();
    for pointer in [
        "/metadata/annotations/meta.helm.sh~1release-name",
        "/metadata/annotations/meta.helm.sh~1release-namespace",
        "/metadata/labels/app.kubernetes.io~1instance",
    ] {
        let mut unrelated = original.clone();
        *unrelated.pointer_mut(pointer).unwrap() = json!("another-release");
        objects.insert(unrelated);
        assert_eq!(
            operations.ensure(&spec(GATEWAY_KIND), None).await,
            Err(ObservationError::BindingMismatch),
            "{pointer}"
        );
        assert!(
            Receipt::load(&operations.state, OWNER, NAME)
                .unwrap()
                .unwrap()
                .gateway
                .is_none()
        );
    }
}

#[tokio::test]
async fn interrupted_authentication_preparation_retains_its_identity_and_signing_key() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    let signing_key = std::fs::read(operations.state.join("auth/signing.pk8")).unwrap();
    let mut receipt = Receipt::load(&operations.state, OWNER, NAME)
        .unwrap()
        .unwrap();
    let last = receipt.issuer.pop().unwrap();
    let path = format!(
        "{}/{}",
        crate::kube_api::collection(&last.api_version, &last.kind, &last.namespace),
        last.name
    );
    objects.0.lock().unwrap().remove(&path);
    receipt.issuer_ready = false;
    receipt.save(&operations.state).unwrap();
    let incomplete = operations
        .read(&spec(AUTH_KIND), auth.id.as_deref())
        .await
        .unwrap();
    assert_eq!(incomplete.id, auth.id);
    assert_eq!(incomplete.running, Some(false));
    let recovered = operations
        .ensure(&spec(AUTH_KIND), auth.id.as_deref())
        .await
        .unwrap();
    assert_eq!(recovered, auth);
    assert_eq!(
        std::fs::read(operations.state.join("auth/signing.pk8")).unwrap(),
        signing_key
    );
}

#[tokio::test]
async fn failed_release_creation_preserves_prepared_authentication_for_retry_or_cleanup() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    let storage = operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    let before = objects.0.lock().unwrap().clone();
    let receipt = std::fs::read(operations.state.join("receipt.json")).unwrap();
    assert_eq!(
        operations.ensure(&spec(GATEWAY_KIND), None).await,
        Err(ObservationError::Incomplete)
    );
    assert_eq!(*objects.0.lock().unwrap(), before);
    assert_eq!(
        std::fs::read(operations.state.join("receipt.json")).unwrap(),
        receipt
    );
    operations
        .remove(&spec(AUTH_KIND), auth.id.as_deref())
        .await
        .unwrap();
    assert_eq!(
        operations
            .read(&spec(STORAGE_KIND), storage.id.as_deref())
            .await
            .unwrap(),
        storage
    );
    assert!(operations.state.join("auth/signing.pk8").is_file());
}

#[tokio::test]
async fn issuer_cleanup_recovers_after_delete_succeeded_before_the_receipt_was_saved() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    let mut receipt = Receipt::load(&operations.state, OWNER, NAME)
        .unwrap()
        .unwrap();
    receipt.issuer_ready = false;
    receipt.save(&operations.state).unwrap();
    let removed = receipt.issuer.last().unwrap();
    let path = format!(
        "{}/{}",
        crate::kube_api::collection(&removed.api_version, &removed.kind, &removed.namespace),
        removed.name
    );
    objects.0.lock().unwrap().remove(&path);
    operations
        .remove(&spec(AUTH_KIND), auth.id.as_deref())
        .await
        .unwrap();
    assert!(
        Receipt::load(&operations.state, OWNER, NAME)
            .unwrap()
            .unwrap()
            .issuer
            .is_empty()
    );
    assert_eq!(
        objects.len(),
        6,
        "only platform prerequisites and retained storage remain"
    );
}

#[tokio::test]
async fn issuer_cleanup_never_deletes_a_replacement_after_interruption() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    let mut receipt = Receipt::load(&operations.state, OWNER, NAME)
        .unwrap()
        .unwrap();
    receipt.issuer_ready = false;
    receipt.save(&operations.state).unwrap();
    let mut replaced = objects
        .get("apps/v1", "Deployment", "agents", &format!("{NAME}-oidc"))
        .unwrap();
    replaced["metadata"]["uid"] = json!("replacement-issuer");
    objects.insert(replaced);
    let before = objects.0.lock().unwrap().clone();
    assert_eq!(
        operations
            .remove(&spec(AUTH_KIND), auth.id.as_deref())
            .await,
        Err(ObservationError::BindingMismatch)
    );
    assert_eq!(*objects.0.lock().unwrap(), before);
    assert_eq!(
        Receipt::load(&operations.state, OWNER, NAME).unwrap(),
        Some(receipt)
    );
}

#[tokio::test]
async fn release_storage_query_errors_stop_observation_and_issuer_cleanup() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    for (code, error) in [
        (401, ObservationError::Authentication),
        (403, ObservationError::Permission),
        (500, ObservationError::Query),
    ] {
        let served = objects.clone();
        let fixture = crate::transport::Fixture::start_tcp(move |request| {
            if request.method == "GET"
                && request
                    .path
                    .starts_with("/api/v1/namespaces/agents/secrets?")
            {
                return Some((
                    code,
                    json!({"apiVersion":"v1", "kind":"Status", "code":code,
                    "status":"Failure", "reason":"Denied"})
                    .to_string()
                    .into_bytes(),
                ));
            }
            served.answer(&request.method, &request.path, &request.body)
        })
        .await;
        let failing = Operations {
            client: client(&fixture),
            server: operations.server.clone(),
            state: operations.state.clone(),
            openshift_wait: operations.openshift_wait,
        };
        let before = objects.0.lock().unwrap().clone();
        assert_eq!(
            failing.read(&spec(AUTH_KIND), auth.id.as_deref()).await,
            Err(error)
        );
        assert_eq!(
            failing.remove(&spec(AUTH_KIND), auth.id.as_deref()).await,
            Err(error)
        );
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn release_presence_uses_only_matching_namespaced_helm_metadata() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    assert_eq!(auth.release_present, Some(false));
    for (object_name, namespace, owner, release) in [
        ("other-release", "agents", "helm", "other-gateway"),
        ("other-owner", "agents", "another-owner", NAME),
        ("other-namespace", "elsewhere", "helm", NAME),
    ] {
        objects.insert(json!({"apiVersion":"v1", "kind":"Secret", "metadata": {
            "name":object_name, "namespace":namespace, "labels":{"owner":owner, "name":release}}}));
    }
    assert_eq!(
        operations
            .read(&spec(AUTH_KIND), auth.id.as_deref())
            .await
            .unwrap()
            .release_present,
        Some(false)
    );
    let release_secret = format!("sh.helm.release.v1.{NAME}.v1");
    objects.insert(json!({"apiVersion":"v1", "kind":"Secret", "metadata": {
        "name":release_secret, "namespace":"agents", "labels":{"owner":"helm", "name":NAME}},
        "data":{"release":"private-release-payload"}}));
    let observed = operations
        .read(&spec(AUTH_KIND), auth.id.as_deref())
        .await
        .unwrap();
    assert_eq!(observed.release_present, Some(true));
    assert!(
        !serde_json::to_string(&observed)
            .unwrap()
            .contains("private-release-payload")
    );
    let before = objects.0.lock().unwrap().clone();
    assert_eq!(
        operations
            .remove(&spec(AUTH_KIND), auth.id.as_deref())
            .await,
        Err(ObservationError::Incomplete)
    );
    assert_eq!(
        *objects.0.lock().unwrap(),
        before,
        "a release without its StatefulSet must still block issuer cleanup"
    );
}

#[tokio::test]
async fn an_incomplete_release_list_cannot_establish_absence() {
    let objects = cluster();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path()).await;
    operations.ensure(&spec(STORAGE_KIND), None).await.unwrap();
    let auth = operations.ensure(&spec(AUTH_KIND), None).await.unwrap();
    for list in [
        json!({"apiVersion":"meta.k8s.io/v1", "kind":"PartialObjectMetadataList", "metadata":{"continue":"next-page"}, "items":[]}),
        json!({"apiVersion":"meta.k8s.io/v1", "kind":"PartialObjectMetadataList", "metadata":{}, "items":[{"metadata":{"labels":{"owner":"another-owner", "name":NAME}}}]}),
    ] {
        let served = objects.clone();
        let fixture = crate::transport::Fixture::start_tcp(move |request| {
            if request.method == "GET"
                && request
                    .path
                    .starts_with("/api/v1/namespaces/agents/secrets?")
            {
                assert!(
                    request
                        .header("accept")
                        .unwrap()
                        .contains("PartialObjectMetadataList")
                );
                return Some((200, list.to_string().into_bytes()));
            }
            served.answer(&request.method, &request.path, &request.body)
        })
        .await;
        let incomplete = Operations {
            client: client(&fixture),
            server: operations.server.clone(),
            state: operations.state.clone(),
            openshift_wait: operations.openshift_wait,
        };
        assert_eq!(
            incomplete
                .read_for_removal(&spec(AUTH_KIND), auth.id.as_deref())
                .await,
            Err(ObservationError::Incomplete)
        );
    }
}
