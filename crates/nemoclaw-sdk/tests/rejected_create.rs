// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A sandbox create that OpenShell rejects as an invalid argument created
//! nothing, so the deployment it left can be corrected and destroyed. Any other
//! failed create may have created a sandbox whose ID was lost, so it keeps the
//! pending creation that holds the original configuration.
//!
//! The scripted events have the shape that OpenTofu reports for a provider
//! error on a resource: an `apply_errored` for the address and a diagnostic
//! that names it. The `openshell-provider` fake-gateway test
//! `only_an_invalid_argument_rejection_reports_a_create_that_made_nothing`
//! pins the provider's side of the marker; change both together.

#![cfg(unix)]

use crate::scripted_tofu::{Scripted, placeholder_generations, plan_json};
use nemoclaw_backend::CREATED_NOTHING_SUMMARY;
use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, Outcome,
    compile::{self, Generations, Target},
    config::Document,
};
use serde_json::Value;

/// The version of the scripted bundle (`support/bundle.rs`).
const VERSION: &str = "0.1.0";

fn document(image: &str) -> Document {
    let mut value: Value = crate::support::fixture("spark.yaml");
    value["spec"]["sandboxes"]["assistant"]["image"]["ref"] = image.into();
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

fn original() -> Document {
    document(&format!("rejected@sha256:{}", "a".repeat(64)))
}

fn corrected() -> Document {
    document(&format!("corrected@sha256:{}", "b".repeat(64)))
}

/// The resources the deployment's graph declares. Compiled targets omit the
/// sandbox images the graph pulls; those are named by the graph alone.
fn targets(document: &Document, generations: &Generations) -> Vec<Target> {
    let mut targets: Vec<Target> = compile::runtime_targets(document, generations)
        .unwrap()
        .into_iter()
        .chain(compile::targets(document, generations).unwrap())
        .filter(|target| !target.address.starts_with("data."))
        .collect();
    let graph = compile::compile(document, generations, VERSION).unwrap();
    for (kind, resources) in graph["resource"].as_object().unwrap() {
        for name in resources.as_object().unwrap().keys() {
            let address = format!("{kind}.{name}");
            if !targets.iter().any(|target| target.address == address) {
                targets.push(Target {
                    kind: kind.clone(),
                    address,
                    values: Default::default(),
                });
            }
        }
    }
    targets
}

fn sandbox(targets: &[Target]) -> String {
    targets
        .iter()
        .map(|target| target.address.clone())
        .find(|address| address.starts_with("openshell_sandbox."))
        .expect("the deployment declares a sandbox")
}

/// A fresh deployment whose first apply failed on the sandbox's create with
/// the diagnostic `summary`, and the sandbox's address.
async fn failed_first_apply(summary: &str) -> (Scripted, Deployment, String, Error) {
    let scripted = Scripted::new();
    let deployment = scripted.deployment(&scripted.path("unused-kubeconfig"));
    let mut generations = placeholder_generations();
    generations.insert("inference_service".into(), "a".repeat(32));
    let planned = targets(&original(), &generations);
    let address = sandbox(&planned);
    scripted.set("root.apply.plan", plan_json(&planned, "create"));
    scripted.set("root.apply", "reject");
    scripted.set("root.reject", &address);
    scripted.set("root.reject-summary", summary);
    let error = deployment
        .apply(&original(), &CancellationToken::new())
        .await
        .expect_err("the apply failed");
    (scripted, deployment, address, error)
}

/// Make the next apply create everything again, from the corrected document.
fn plan_corrected_apply(scripted: &Scripted) {
    let mut generations = scripted.generations();
    generations.insert("inference_service".into(), "a".repeat(32));
    scripted.set(
        "root.apply.plan",
        plan_json(&targets(&corrected(), &generations), "create"),
    );
    scripted.set("root.apply", "ok");
}

#[tokio::test]
async fn a_rejected_create_leaves_a_deployment_that_can_be_corrected() {
    let (scripted, deployment, address, error) = failed_first_apply(CREATED_NOTHING_SUMMARY).await;
    assert!(
        matches!(&error, Error::Execution { uncreated: Some(uncreated), .. } if uncreated == &[address]),
        "{error:?}"
    );
    plan_corrected_apply(&scripted);
    let applied = deployment
        .apply(&corrected(), &CancellationToken::new())
        .await
        .expect("the corrected configuration applies");
    assert_eq!(applied.outcome, Outcome::Succeeded);
}

#[tokio::test]
async fn a_rejected_create_leaves_a_deployment_that_can_be_destroyed() {
    // The scripted bundle lives as long as `_scripted`.
    let (_scripted, deployment, ..) = failed_first_apply(CREATED_NOTHING_SUMMARY).await;
    let destroyed = deployment
        .destroy(&CancellationToken::new())
        .await
        .expect("nothing the rejected create left holds destroy back");
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
}

#[tokio::test]
async fn any_other_failed_create_keeps_the_original_configuration_pending() {
    let (scripted, deployment, _, error) = failed_first_apply("Apply incomplete").await;
    assert!(
        matches!(
            &error,
            Error::Execution {
                uncreated: None,
                ..
            }
        ),
        "{error:?}"
    );
    plan_corrected_apply(&scripted);
    let refused = deployment
        .apply(&corrected(), &CancellationToken::new())
        .await
        .expect_err("the unfinished creation still guards its configuration");
    assert!(
        matches!(&refused, Error::Conflict(reason) if reason.contains("unfinished creation")),
        "{refused:?}"
    );
    let held = deployment.destroy(&CancellationToken::new()).await;
    assert!(
        matches!(held, Err(Error::Conflict(_) | Error::State(_))),
        "an unresolved creation still holds destroy back: {held:?}"
    );
}
