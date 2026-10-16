// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored edits to bound sandboxes are refused without mutation.
//! The public SDK runs over scripted OpenTofu; native runtime/sandbox refusal
//! and provider behavior remain covered by the bundled remote-service tests.

#![cfg(unix)]

use crate::scripted_tofu::{
    Events, Scripted, placeholder_generations, plan_json, planning, state_json,
};
use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, Outcome,
    compile::{self, Target},
    config::Document,
};
use serde_json::{Value, json};
use std::fs;

fn document() -> Document {
    let mut value = crate::support::fixture("local.yaml");
    let mut reviewer = value["spec"]["sandboxes"][0].clone();
    reviewer["name"] = json!("reviewer");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(reviewer);
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

fn targets(document: &Document, generations: &compile::Generations) -> Vec<Target> {
    compile::targets(document, generations).unwrap()
}

/// A completed public apply with fresh readiness observations, followed by
/// bindings carrying the generations the SDK allocated. Scripted OpenTofu
/// supplies observations; this does not establish provider or host behavior.
async fn applied(scripted: &Scripted, document: &Document) -> Deployment {
    let declared = targets(document, &placeholder_generations());
    let mut plan: Value = serde_json::from_str(&plan_json(&declared, "create")).unwrap();
    let mut readiness = Vec::new();
    for sandbox in &document.spec.sandboxes {
        let address = format!("data.fabric_agent_readiness.{}", sandbox.name);
        plan["resource_changes"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "address": address, "mode": "data",
                "change": {"actions": ["read"], "before": null, "after": null}
            }));
        readiness.push(json!({
            "address": address, "mode": "data",
            "values": {
                "read_trigger": "fresh-readiness",
                "ready": true,
                "health_json": json!({
                    "supported": true, "report": {"fixture": true}, "reason_code": null
                }).to_string()
            }
        }));
    }
    scripted.set("root.apply.plan", plan.to_string());
    scripted.set(
        "root.state",
        json!({
            "format_version": "1.0",
            "values": {"root_module": {"resources": readiness}}
        })
        .to_string(),
    );
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
async fn removing_or_replacing_a_bound_sandbox_preserves_intent_and_state_without_mutation() {
    let scripted = Scripted::new();
    let original = document();
    let deployment = applied(&scripted, &original).await;
    let intent = scripted.intent();
    let state = fs::read(scripted.state().join("terraform.tfstate")).unwrap();

    for change in ["remove", "image", "policy"] {
        let mut value = serde_json::to_value(&original).unwrap();
        match change {
            "remove" => {
                value["spec"]["sandboxes"].as_array_mut().unwrap().pop();
            }
            "image" => {
                value["spec"]["sandboxes"][1]["image"]["ref"] =
                    json!(format!("sandbox@sha256:{}", "c".repeat(64)));
            }
            "policy" => {
                value["spec"]["sandboxes"][1]["network"] =
                    json!({"policy": {"explicit": {"version": 1, "network_policies": {}}}});
            }
            _ => unreachable!(),
        }
        let rejected = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
        for apply in [false, true] {
            let events = Events::default();
            let deployment = deployment.clone().with_progress(events.recording());
            let before = scripted.commands().len();
            let result = if apply {
                deployment.apply(&rejected, &CancellationToken::new()).await
            } else {
                deployment.plan(&rejected, &CancellationToken::new()).await
            };
            assert!(
                matches!(&result, Err(Error::SandboxChangeRefused { sandbox, action })
                    if sandbox == "reviewer" && *action == if change == "remove" { "remove" } else { "replace" }),
                "{change}, apply={apply}: {result:?}"
            );
            assert_eq!(
                scripted.intent(),
                intent,
                "{change}, apply={apply}: intent changed"
            );
            assert_eq!(
                fs::read(scripted.state().join("terraform.tfstate")).unwrap(),
                state,
                "{change}, apply={apply}: state changed"
            );
            let commands = scripted.commands();
            assert!(
                !commands[before..]
                    .iter()
                    .any(|command| command.ends_with(" apply")),
                "{change}, apply={apply}: started a mutation: {commands:?}"
            );
            events.assert_mutations(0, change);
        }
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
