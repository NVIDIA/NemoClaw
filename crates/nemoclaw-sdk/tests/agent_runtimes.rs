// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Plan and apply report each sandbox's agent with the runtime ID that
//! OpenTofu state records for it, so a person can invoke the agent without
//! reading state. Scripted OpenTofu supplies plans and state; the Fabric
//! provider's contract tests cover when a runtime gets a new ID.

#![cfg(unix)]

use crate::scripted_tofu::{Events, Scripted, placeholder_generations, plan_json, state_json};
use nemoclaw_sdk::{
    CancellationToken, OperationResult, Outcome, Progress,
    compile::{self, Target},
    config::Document,
};
use serde_json::{Value, json};
use std::sync::Arc;

/// One sandbox, `assistant`, whose agent is named `main`.
fn document() -> Document {
    Document::parse(
        serde_json::to_vec(&crate::support::fixture("local.yaml"))
            .unwrap()
            .as_slice(),
    )
    .unwrap()
}

fn targets(document: &Document, generations: &compile::Generations) -> Vec<Target> {
    compile::targets(document, generations).unwrap()
}

/// State binding every target, with the runtime ID Fabric gave the agent.
fn state_with_runtime(targets: &[Target], runtime_id: &str) -> String {
    let mut state: Value = serde_json::from_str(&state_json(targets)).unwrap();
    for resource in state["values"]["root_module"]["resources"]
        .as_array_mut()
        .unwrap()
    {
        if resource["address"] == "fabric_agent.assistant" {
            resource["values"]["runtime_id"] = json!(runtime_id);
        }
    }
    state.to_string()
}

fn agents(result: &OperationResult) -> Value {
    serde_json::to_value(result).unwrap()["agents"].clone()
}

#[tokio::test]
async fn plan_and_apply_report_each_agent_with_its_runtime_id_and_an_unchanged_reapply_keeps_it() {
    let scripted = Scripted::new();
    let document = document();
    let declared = targets(&document, &placeholder_generations());
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    let deployment = scripted.deployment(&scripted.path("unused-kubeconfig"));
    let cancel = CancellationToken::new();

    // Before the first apply, the agent has no runtime, so no ID.
    let planned = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(
        agents(&planned),
        json!({"assistant": {"agent": "main"}}),
        "a plan before any apply"
    );

    scripted.set("root.state", state_with_runtime(&declared, "rt-1"));
    let created = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(created.outcome, Outcome::Succeeded);
    // The agent name and runtime ID, and nothing else, such as a credential.
    assert_eq!(
        agents(&created),
        json!({"assistant": {"agent": "main", "runtimeId": "rt-1"}}),
        "the first apply"
    );

    let declared = targets(&document, &scripted.generations());
    scripted.set("root.state", state_with_runtime(&declared, "rt-1"));
    scripted.set("root.apply.plan", plan_json(&declared, "no-op"));
    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert!(unchanged.changes.is_empty(), "{:?}", unchanged.changes);
    assert_eq!(
        agents(&unchanged),
        json!({"assistant": {"agent": "main", "runtimeId": "rt-1"}}),
        "an unchanged reapply"
    );

    let planned = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(planned.outcome, Outcome::Planned);
    assert_eq!(
        agents(&planned),
        json!({"assistant": {"agent": "main", "runtimeId": "rt-1"}}),
        "a plan after apply"
    );
}

/// Apply reads the runtime ID after its changes, so a runtime that apply
/// replaced is reported by its new ID.
#[tokio::test]
async fn apply_reports_the_new_runtime_id_after_it_replaces_a_runtime() {
    let scripted = Scripted::new();
    let document = document();
    let declared = targets(&document, &placeholder_generations());
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    scripted.set("root.state", state_with_runtime(&declared, "rt-1"));
    let deployment = scripted.deployment(&scripted.path("unused-kubeconfig"));
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();

    let declared = targets(&document, &scripted.generations());
    scripted.set("root.state", state_with_runtime(&declared, "rt-1"));
    scripted.set("root.apply.plan", plan_json(&declared, "no-op"));
    // Fabric starts another runtime while OpenTofu applies.
    let (state, replaced) = (
        scripted.path("control").join("root.state"),
        state_with_runtime(&declared, "rt-2"),
    );
    let replacing = deployment.with_progress(Arc::new(move |event| {
        if event == Progress::Applying {
            std::fs::write(&state, &replaced).unwrap();
        }
    }));
    let result = replacing.apply(&document, &cancel).await.unwrap();
    assert_eq!(
        agents(&result),
        json!({"assistant": {"agent": "main", "runtimeId": "rt-2"}})
    );
}

#[tokio::test]
async fn apply_omits_the_runtime_id_of_an_agent_without_one() {
    let scripted = Scripted::new();
    let document = document();
    let declared = targets(&document, &placeholder_generations());
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    scripted.set("root.state", state_with_runtime(&declared, ""));
    let result = scripted
        .deployment(&scripted.path("unused-kubeconfig"))
        .apply(&document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(agents(&result), json!({"assistant": {"agent": "main"}}));
}

/// The apply is saved before its state is read, so a failed read still reports
/// success, without runtime IDs and with a warning that says so.
#[tokio::test]
async fn apply_succeeds_with_a_warning_when_reading_runtime_ids_fails() {
    let scripted = Scripted::new();
    let document = document();
    let declared = targets(&document, &placeholder_generations());
    scripted.set("root.apply.plan", plan_json(&declared, "create"));
    scripted.set("root.state", "not json");
    let events = Events::default();
    let result = scripted
        .deployment(&scripted.path("unused-kubeconfig"))
        .with_progress(events.recording())
        .apply(&document, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.outcome, Outcome::Succeeded);
    assert!(
        serde_json::to_value(&result)
            .unwrap()
            .get("agents")
            .is_none(),
        "unread runtime IDs were reported"
    );
    assert!(
        events.contains(|event| matches!(
            event,
            Progress::Warning { message } if message.contains("runtime IDs")
        )),
        "no warning"
    );
}
