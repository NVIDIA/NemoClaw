// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored edits that remove or replace a bound sandbox reach planning, where
//! OpenTofu plans the deletion or replacement. The public SDK runs over
//! scripted OpenTofu; provider behavior is covered by the bundled tests.

#![cfg(unix)]

use crate::scripted_tofu::{
    Events, Scripted, placeholder_generations, plan_json, planning, state_json,
};
use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, Outcome,
    compile::{self, Target},
    config::Document,
};
use serde_json::json;
use std::fs;

fn document() -> Document {
    let mut value = crate::support::fixture("local.yaml");
    let reviewer = value["spec"]["sandboxes"]["assistant"].clone();
    value["spec"]["sandboxes"]["reviewer"] = reviewer;
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

fn targets(document: &Document, generations: &compile::Generations) -> Vec<Target> {
    compile::targets(document, generations).unwrap()
}

/// A completed public apply followed by bindings carrying the generations the
/// SDK allocated. Scripted OpenTofu supplies plans and state; this does not
/// establish provider or host behavior.
async fn applied(scripted: &Scripted, document: &Document) -> Deployment {
    let declared = targets(document, &placeholder_generations());
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    let deployment = scripted.deployment(&scripted.path("unused-kubeconfig"));
    let result = deployment
        .apply(document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.outcome, Outcome::Succeeded);
    let declared = targets(document, &scripted.generations());
    scripted.set("root.state", state_json(&declared));
    scripted.set("root.apply.plan", plan_json(&declared, "no-op"));
    deployment
}

#[tokio::test]
async fn removing_or_replacing_a_bound_sandbox_reaches_planning() {
    let scripted = Scripted::new();
    let original = document();
    let deployment = applied(&scripted, &original).await;
    let intent = scripted.intent();
    let state = fs::read(scripted.state().join("terraform.tfstate")).unwrap();

    for change in ["remove", "image", "policy"] {
        let mut value = serde_json::to_value(&original).unwrap();
        match change {
            "remove" => {
                value["spec"]["sandboxes"]
                    .as_object_mut()
                    .unwrap()
                    .remove("reviewer");
            }
            "image" => {
                value["spec"]["sandboxes"]["reviewer"]["image"]["ref"] =
                    json!(format!("sandbox@sha256:{}", "c".repeat(64)));
            }
            "policy" => {
                value["spec"]["sandboxes"]["reviewer"]["network"] =
                    json!({"policy": {"explicit": {"version": 1, "network_policies": {}}}});
            }
            _ => unreachable!(),
        }
        let revised = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
        // Stop at planning: the revision is admitted, and nothing is mutated.
        let (events, token) = (Events::default(), CancellationToken::new());
        let result = deployment
            .clone()
            .with_progress(events.cancelling(&token, planning))
            .plan(&revised, &token)
            .await;
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "{change}: {result:?}"
        );
        assert!(events.contains(planning), "{change}: planning not reached");
        events.assert_mutations(0, change);
        assert_eq!(scripted.intent(), intent, "{change}: intent changed");
        assert_eq!(
            fs::read(scripted.state().join("terraform.tfstate")).unwrap(),
            state,
            "{change}: state changed"
        );
    }

    // A permitted display-name edit reaches planning through the same bindings.
    // Refusals did not poison the saved record, and the fixture is not refusing
    // every revised document before the admission check can run.
    let mut permitted = original.clone();
    permitted.metadata.name = "renamed-display".into();
    let (events, token) = (Events::default(), CancellationToken::new());
    let result = deployment
        .with_progress(events.cancelling(&token, planning))
        .plan(&permitted, &token)
        .await;
    assert!(matches!(result, Err(Error::Cancelled)), "{result:?}");
    assert!(events.contains(planning));
    events.assert_mutations(0, "permitted display-name edit");
    assert_eq!(scripted.intent(), intent);
    assert_eq!(
        fs::read(scripted.state().join("terraform.tfstate")).unwrap(),
        state
    );
}
