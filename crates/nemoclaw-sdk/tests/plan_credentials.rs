// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The credential references plan and apply resolve.
//!
//! Plan reads the gateway's and the cluster's references and image metadata
//! files. Only apply reads inference and integration credentials, when it
//! registers their providers, so plan reports a missing one as deferred and
//! apply resolves every reference before it changes anything.
//!
//! A script stands in for OpenTofu (see `scripted_tofu`) and records the
//! environment it receives, so these tests establish what the SDK resolves and
//! passes, not what the providers read.

#![cfg(unix)]

use crate::scripted_tofu::{Scripted, kubernetes_document, placeholder_generations, plan_json};
use nemoclaw_sdk::{
    CancellationToken, Error, ObservationError,
    compile::{self, Target},
    config::Document,
};
use serde_json::json;

const INFERENCE_KEY: &str = "TEST_INFERENCE_KEY";

/// A managed Kubernetes deployment whose inference provider names a credential
/// that the scripted deployment's secrets don't resolve.
fn document() -> Document {
    let mut value = serde_json::to_value(kubernetes_document("local-agent", "agents")).unwrap();
    value["spec"]["inferenceProviders"]["local"]["credential"] = json!({"env": INFERENCE_KEY});
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

/// A scripted OpenTofu whose plan creates every resource of `document`.
fn fresh(document: &Document) -> Scripted {
    let scripted = Scripted::new();
    let generations = placeholder_generations();
    let targets: Vec<Target> = compile::runtime_targets(document, &generations)
        .unwrap()
        .into_iter()
        .chain(compile::targets(document, &generations).unwrap())
        .filter(|target| !target.address.starts_with("data."))
        .collect();
    scripted.set("root.apply.plan", plan_json(&targets, "create"));
    scripted
}

#[test]
fn plan_reads_only_gateway_cluster_and_image_metadata_references() {
    let document = document();
    assert_eq!(
        document.credential_names(),
        ["TEST_IMAGE_METADATA", INFERENCE_KEY, "TEST_KUBECONFIG"]
    );
    assert_eq!(
        document.plan_credential_names(),
        ["TEST_IMAGE_METADATA", "TEST_KUBECONFIG"]
    );
    // Search and API integrations are registered by apply, like inference.
    let travel =
        Document::parse(include_bytes!("../../../examples/features/travel-team.yaml").as_slice())
            .unwrap();
    assert_eq!(
        travel.credential_names(),
        ["BOOKINGS_API_KEY", "BRAVE_API_KEY", "NVIDIA_API_KEY"]
    );
    assert!(travel.plan_credential_names().is_empty());
}

/// Without the inference credential, plan still runs: OpenTofu's plan doesn't
/// receive the reference, and the result defers it to apply.
#[tokio::test]
async fn plan_defers_a_missing_inference_credential() {
    let document = document();
    let scripted = fresh(&document);
    let result = scripted
        .deployment(&scripted.path("kubeconfig"))
        .plan(&document, &CancellationToken::new())
        .await
        .expect("plan needs no inference credential");
    let environment = scripted.environment("plan").expect("OpenTofu planned");
    assert!(environment.contains_key("TEST_IMAGE_METADATA"));
    assert!(!environment.contains_key(INFERENCE_KEY));
    let deferral = format!(
        "Credential reference {INFERENCE_KEY} is unavailable or unverified; resolve it before apply."
    );
    assert!(result.deferred.contains(&deferral), "{:?}", result.deferred);
}

/// Apply resolves every reference before OpenTofu plans, so a missing
/// inference credential stops it before anything changes or is recorded.
#[tokio::test]
async fn apply_requires_the_inference_credential_before_opentofu_plans() {
    let document = document();
    let scripted = fresh(&document);
    let error = scripted
        .deployment(&scripted.path("kubeconfig"))
        .apply(&document, &CancellationToken::new())
        .await
        .expect_err("apply needs every credential");
    assert!(
        matches!(error, Error::Observation(ObservationError::Authentication)),
        "{error:?}"
    );
    let commands = scripted.commands();
    assert!(
        !commands
            .iter()
            .any(|command| command == "root plan" || command == "root apply"),
        "{commands:?}"
    );
    assert_eq!(scripted.intent(), None);
}
