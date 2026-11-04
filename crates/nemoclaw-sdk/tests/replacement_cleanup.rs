// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A model service's replacement whose cleanup failed leaves the old container
//! in OpenTofu state as a deposed object. OpenTofu and the Docker provider own
//! that cleanup (`docs/provider.md`); the SDK must let apply and destroy finish
//! it, and export must refuse until it is done.
//!
//! The canned plans and states have the shapes the pinned OpenTofu and Docker
//! provider report for a deposed container: a pending delete names the old ID,
//! and a delete whose reply was lost refreshes to a no-op with neither a before
//! nor an after value. The `nemoclaw-provider` contract test
//! `replacement_cleanup` pins those shapes; change both together.

#![cfg(unix)]

use crate::scripted_tofu::{
    Scripted, destroy_plan_json, placeholder_generations, plan_json, state_json,
};
use nemoclaw_sdk::{
    CancellationToken, Change, Deployment, Error, Outcome,
    compile::{self, Generations, Target},
    config::Document,
};
use serde_json::{Value, json};

const KEY: &str = "deadbeef";
const OLD: &str = "old-container";
/// The version of the scripted bundle (`support/bundle.rs`).
const VERSION: &str = "0.1.0";

fn document() -> Document {
    Document::parse(
        serde_json::to_vec(&crate::support::fixture("spark.yaml"))
            .unwrap()
            .as_slice(),
    )
    .unwrap()
}

/// The resources the deployment's graph declares. Compiled targets omit the
/// sandbox images the graph pulls; those are named by the graph alone.
fn targets(generations: &Generations) -> Vec<Target> {
    let mut targets: Vec<Target> = compile::runtime_targets(&document(), generations)
        .unwrap()
        .into_iter()
        .chain(compile::targets(&document(), generations).unwrap())
        .filter(|target| !target.address.starts_with("data."))
        .collect();
    let graph = compile::compile(&document(), generations, VERSION).unwrap();
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

/// The address of the model service's container.
fn container(targets: &[Target]) -> String {
    targets
        .iter()
        .map(|target| target.address.clone())
        .find(|address| address.starts_with("docker_container.inference_service_"))
        .expect("the model service runs in a Docker container")
}

/// Append `entry` to the list at `pointer` in a canned `show -json` document.
fn with(json: String, pointer: &str, entry: Value) -> String {
    let mut value: Value = serde_json::from_str(&json).unwrap();
    let list = value.pointer_mut(pointer).unwrap().as_array_mut().unwrap();
    list.push(entry);
    value.to_string()
}

/// State whose container also holds the old container deposed under `KEY`.
fn pending_state(targets: &[Target]) -> String {
    with(
        state_json(targets),
        "/values/root_module/resources",
        json!({"address": container(targets), "mode": "managed", "deposed_key": KEY, "values": {"id": OLD, "name": OLD}}),
    )
}

/// `plan_json` or `destroy_plan_json` with the deposed container's change.
fn with_cleanup(plan: String, targets: &[Target], present: bool) -> String {
    let change = if present {
        json!({"actions": ["delete"], "before": {"id": OLD, "name": OLD}, "after": null})
    } else {
        json!({"actions": ["no-op"], "before": null, "after": null})
    };
    with(
        plan,
        "/resource_changes",
        json!({"address": container(targets), "mode": "managed", "deposed": KEY, "change": change}),
    )
}

fn cleanup(targets: &[Target]) -> Change {
    Change {
        resource: format!("{} (deposed {KEY})", container(targets)),
        actions: vec!["delete".into()],
        reason: None,
    }
}

/// Export the deployment, and whether it reached its refresh: the only
/// `-refresh-only` plan the SDK runs. The script answers that refresh with no
/// observations, so export never succeeds here.
async fn export(scripted: &Scripted, deployment: &Deployment) -> (Error, bool) {
    let refreshes = || {
        scripted
            .calls()
            .iter()
            .filter(|call| call.contains("-refresh-only"))
            .count()
    };
    let before = refreshes();
    let error = deployment
        .export(&CancellationToken::new())
        .await
        .unwrap_err();
    (error, refreshes() > before)
}

#[tokio::test]
async fn apply_and_destroy_finish_replacement_cleanup_and_export_waits_for_it() {
    let scripted = Scripted::new();
    let deployment = scripted.deployment(&scripted.path("unused-kubeconfig"));
    let mut generations = placeholder_generations();
    generations.insert("inference_service".into(), "a".repeat(32));
    scripted.set(
        "root.apply.plan",
        plan_json(&targets(&generations), "create"),
    );
    let created = deployment
        .apply(&document(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(created.outcome, Outcome::Succeeded);
    let bound = targets(&scripted.generations());
    let unchanged = plan_json(&bound, "no-op");

    // Cleanup fails: OpenTofu ran it, and the old container stays in state.
    scripted.set("root.state", pending_state(&bound));
    scripted.set(
        "root.apply.plan",
        with_cleanup(unchanged.clone(), &bound, true),
    );
    scripted.set("root.apply", "fail");
    let failed = deployment
        .apply(&document(), &CancellationToken::new())
        .await;
    assert!(
        matches!(failed, Err(Error::Execution { ref operation, .. }) if operation == "apply"),
        "{failed:?}"
    );
    let (refused, refreshed) = export(&scripted, &deployment).await;
    assert!(
        matches!(&refused, Error::Conflict(reason) if reason.contains("replacement cleanup is unfinished")),
        "{refused:?}"
    );
    assert!(!refreshed);

    // The next apply deletes only the old container.
    scripted.set("root.apply", "ok");
    let recovered = deployment
        .apply(&document(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(recovered.outcome, Outcome::Succeeded);
    assert_eq!(recovered.changes, vec![cleanup(&bound)]);
    scripted.set("root.state", state_json(&bound));
    assert!(export(&scripted, &deployment).await.1);

    // A lost delete reply leaves the old container in state; refresh finds it
    // absent and apply has nothing to do.
    scripted.set("root.state", pending_state(&bound));
    scripted.set("root.apply.plan", with_cleanup(unchanged, &bound, false));
    let settled = deployment
        .apply(&document(), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(settled.outcome, Outcome::Succeeded);
    assert_eq!(settled.changes, Vec::new());

    // Destroy deletes the current and the old container and retains storage.
    let established = bound.iter().map(|target| target.address.clone()).collect();
    let teardown =
        compile::compile_teardown(&document(), &scripted.generations(), VERSION, &established)
            .unwrap();
    let retained: Vec<&str> = teardown.retained.iter().map(String::as_str).collect();
    scripted.set(
        "root.destroy.plan",
        with_cleanup(destroy_plan_json(&bound, &retained), &bound, true),
    );
    let destroyed = deployment.destroy(&CancellationToken::new()).await.unwrap();
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
    assert!(
        destroyed.changes.contains(&cleanup(&bound)),
        "{:?}",
        destroyed.changes
    );
}
