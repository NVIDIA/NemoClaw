// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A lost response to a create leaves an object that a re-run refuses and never adopts.
//!
//! For each object that `Operations::ensure` creates for storage and
//! authentication, the fake API server commits the create and drops the
//! connection before answering. The cluster then holds an object the receipt
//! does not record. A re-run with a healthy client must refuse it: the object,
//! the receipt and the local authentication files stay as they were, and the
//! only write sent is the refused create.
//!
//! The unrecorded object stays in the cluster until someone removes it. A later
//! change that adopts or removes it after verifying ownership is expected to
//! change these tests. They call the SDK's Kubernetes operations, not the
//! OpenTofu provider, and they do not cover the OpenShift Namespace identity
//! step.
#![cfg(unix)]

use crate::kube_api::collection;
use crate::kube_faults::{
    Fault, Snapshot,
    platform::{self, NAME, OWNER},
    serve,
};
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::{AUTH_KIND, STORAGE_KIND, receipt::Receipt},
};
use serde_json::Value;

/// A rule that commits the first create of `name` in `collection`, then drops
/// the connection. Several issuer objects share a collection, so the body's
/// name selects the one.
fn lose_response_to(
    collection: &str,
    name: &str,
) -> impl FnMut(&str, &str, &[u8]) -> Option<Fault> + Send + 'static {
    let (collection, name, mut lost) = (collection.to_owned(), name.to_owned(), false);
    move |method, path, body| {
        let named = serde_json::from_slice::<Value>(body)
            .is_ok_and(|object| object["metadata"]["name"] == name.as_str());
        let first = method == "POST" && path == collection && named && !lost;
        lost |= first;
        first.then_some(Fault::CommitThenDrop)
    }
}

/// Lose the response to the create of `name`, then repeat `stage` with a
/// healthy client. `stage` is the operation that creates the object.
async fn assert_unrecorded_object_is_refused(
    stage: &str,
    api_version: &str,
    kind: &str,
    namespace: &str,
    name: &str,
) {
    let objects = platform::cluster();
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let collection = collection(api_version, kind, namespace);
    let label = format!("{kind} {name}");

    let lossy = serve(&objects, lose_response_to(&collection, name)).await;
    let first = platform::operations(lossy.client(), lossy.endpoint(), &state);
    if stage == AUTH_KIND {
        first
            .ensure(&platform::spec(STORAGE_KIND), None)
            .await
            .unwrap();
    }
    let lost = first.ensure(&platform::spec(stage), None).await;
    assert_eq!(
        lost,
        Err(ObservationError::Transport),
        "the run that lost the {label} create response"
    );

    // The premise: the object exists, the receipt does not record it, and the
    // issuer's local files exist for the re-run to leave alone.
    let requests = lossy.requests();
    assert_eq!(
        lossy.faults_fired(),
        1,
        "the {label} create response was not lost: {requests:?}"
    );
    assert!(
        objects.get(api_version, kind, namespace, name).is_some(),
        "the {label} create was not committed: {requests:?}"
    );
    let receipt = Receipt::load(&state, OWNER, NAME)
        .unwrap()
        .expect("the first run left no receipt");
    let mut recorded = receipt.objects.iter().chain(&receipt.issuer);
    assert!(
        !recorded.any(|owned| owned.kind == kind && owned.name == name),
        "the receipt already records the {label}: {receipt:?}"
    );
    assert!(
        stage != AUTH_KIND || state.join("auth/signing.pk8").exists(),
        "the first run left no authentication files"
    );

    let before = Snapshot::capture(&objects, &state);
    // The receipt binds the cluster by its server address, so the re-run keeps
    // the first run's address and sends its requests to a healthy server.
    let healthy = serve(&objects, |_, _, _| None).await;
    let rerun = platform::operations(healthy.client(), lossy.endpoint(), &state);
    let result = rerun.ensure(&platform::spec(stage), None).await;

    assert_eq!(
        result,
        Err(ObservationError::BindingMismatch),
        "re-run over an unrecorded {label}, requests: {:?}",
        healthy.requests()
    );
    assert_eq!(
        healthy.mutations(),
        [("POST".to_owned(), collection.clone())],
        "re-run over an unrecorded {label} must send only the refused create"
    );
    before.assert_unchanged(
        &objects,
        &state,
        &format!("re-run over an unrecorded {label}"),
    );

    // Control: with the unrecorded object gone, the same stage completes, so the
    // refusal above was caused by that object and not by anything else in the re-run.
    objects
        .0
        .lock()
        .unwrap()
        .remove(&format!("{collection}/{name}"));
    let control = rerun.ensure(&platform::spec(stage), None).await;
    assert!(
        control.is_ok(),
        "without the unrecorded {label} the stage still failed: {control:?}, requests: {:?}",
        healthy.requests()
    );
}

#[tokio::test]
async fn a_rerun_refuses_a_namespace_whose_create_response_was_lost() {
    assert_unrecorded_object_is_refused(STORAGE_KIND, "v1", "Namespace", "", "agents").await;
}

#[tokio::test]
async fn a_rerun_refuses_a_key_secret_whose_create_response_was_lost() {
    let key = format!("{NAME}-kek");
    assert_unrecorded_object_is_refused(STORAGE_KIND, "v1", "Secret", "agents", &key).await;
}

#[tokio::test]
async fn a_rerun_refuses_an_issuer_ca_config_map_whose_create_response_was_lost() {
    let name = format!("{NAME}-oidc-ca");
    assert_unrecorded_object_is_refused(AUTH_KIND, "v1", "ConfigMap", "agents", &name).await;
}

#[tokio::test]
async fn a_rerun_refuses_an_issuer_tls_secret_whose_create_response_was_lost() {
    let name = format!("{NAME}-oidc");
    assert_unrecorded_object_is_refused(AUTH_KIND, "v1", "Secret", "agents", &name).await;
}

#[tokio::test]
async fn a_rerun_refuses_an_issuer_documents_config_map_whose_create_response_was_lost() {
    let name = format!("{NAME}-oidc");
    assert_unrecorded_object_is_refused(AUTH_KIND, "v1", "ConfigMap", "agents", &name).await;
}

#[tokio::test]
async fn a_rerun_refuses_an_issuer_service_whose_create_response_was_lost() {
    let name = format!("{NAME}-oidc");
    assert_unrecorded_object_is_refused(AUTH_KIND, "v1", "Service", "agents", &name).await;
}

#[tokio::test]
async fn a_rerun_refuses_an_issuer_network_policy_whose_create_response_was_lost() {
    let name = format!("{NAME}-oidc");
    let api = "networking.k8s.io/v1";
    assert_unrecorded_object_is_refused(AUTH_KIND, api, "NetworkPolicy", "agents", &name).await;
}

#[tokio::test]
async fn a_rerun_refuses_an_issuer_deployment_whose_create_response_was_lost() {
    let name = format!("{NAME}-oidc");
    assert_unrecorded_object_is_refused(AUTH_KIND, "apps/v1", "Deployment", "agents", &name).await;
}
