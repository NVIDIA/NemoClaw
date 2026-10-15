// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Interrupted and refused operations on a managed Kubernetes deployment leave
//! the state that the next run recovers from (`docs/design/scope.md`, Ownership
//! and Recovery).
//!
//! Each test drives `Deployment` over a bundle whose OpenTofu is a script (see
//! `scripted_tofu`), interrupts or refuses one step, and then asks the public
//! operations what the SDK kept. The tests compare the saved record's text before
//! and after an operation; only `Scripted::generations` decodes it, for the
//! tests whose canned bindings must carry the generations of the first apply.
//!
//! A script stands in for OpenTofu, so these tests establish what the SDK saves
//! and refuses for the results the script returns, not what OpenTofu or the
//! providers do; `nemoclaw-e2e`'s `helm_recovery` runs the bundled ones,
//! including interrupted destroys.

#![cfg(unix)]

use crate::scripted_tofu::{
    Events, Scripted, destroy_plan_json, destroying, kubernetes_document, placeholder_generations,
    plan_json, planning, state_json,
};
use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, OperationResult,
    compile::{self, Target},
    config::Document,
    kubernetes::{AUTH_KIND, STORAGE_KIND},
};
use std::{
    fmt::Debug,
    fs,
    path::{Path, PathBuf},
};

const STORAGE: &str = "openshell_kubernetes_storage.runtime";

fn original() -> Document {
    kubernetes_document("local-agent", "agents")
}

/// The same deployment on another namespace: another platform identity.
fn another_namespace() -> Document {
    kubernetes_document("local-agent", "other-agents")
}

/// A scripted OpenTofu for a deployment that was never applied: its plan
/// creates every platform resource.
fn fresh() -> Scripted {
    let scripted = Scripted::new();
    let generations = placeholder_generations();
    let targets: Vec<Target> = compile::runtime_targets(&original(), &generations)
        .unwrap()
        .into_iter()
        .chain(compile::targets(&original(), &generations).unwrap())
        .filter(|target| !target.address.starts_with("data."))
        .collect();
    scripted.set("root.apply.plan", plan_json(&targets, "create"));
    scripted
}

/// A token that is not cancelled. An operation after a cancelled one needs its own.
fn uncancelled() -> CancellationToken {
    CancellationToken::new()
}

/// A kubeconfig path that no file occupies.
fn missing(scripted: &Scripted) -> PathBuf {
    scripted.path("missing-kubeconfig")
}

fn assert_conflict<T: Debug>(result: Result<T, Error>, reason: &str, context: &str) {
    match result {
        Err(Error::Conflict(found)) if found.contains(reason) => {}
        other => panic!("{context}: expected a conflict about {reason:?}, got {other:?}"),
    }
}

/// The operation ran: nothing refused or cancelled it. The script provides no
/// sandbox observations, so a run that reaches them may still fail there.
fn assert_not_refused<T: Debug>(result: Result<T, Error>, context: &str) {
    assert!(
        !matches!(&result, Err(Error::Conflict(_) | Error::Cancelled)),
        "{context}: expected the operation to run, got {result:?}"
    );
}

fn assert_cancelled<T: Debug>(result: Result<T, Error>, context: &str) {
    assert!(
        matches!(result, Err(Error::Cancelled)),
        "{context}: expected a cancelled operation, got {result:?}"
    );
}

fn count(commands: &[String], wanted: &str) -> usize {
    commands.iter().filter(|command| *command == wanted).count()
}

fn assert_applies(scripted: &Scripted, expected: usize, context: &str) {
    let commands = scripted.commands();
    assert_eq!(
        count(&commands, "root apply"),
        expected,
        "{context}: {commands:?}"
    );
}

/// The saved record's text is as it was.
fn assert_record(scripted: &Scripted, saved: &Option<String>, context: &str) {
    assert_eq!(
        &scripted.intent(),
        saved,
        "{context}: the saved record changed"
    );
}

/// Apply `document` and cancel at the first event `when` accepts.
async fn apply_cancelled_at(
    scripted: &Scripted,
    document: &Document,
    kubeconfig: &Path,
    when: fn(&nemoclaw_sdk::Progress) -> bool,
) -> (Result<OperationResult, Error>, Events) {
    let (events, token) = (Events::default(), uncancelled());
    let result = scripted
        .deployment(kubeconfig)
        .with_progress(events.cancelling(&token, when))
        .apply(document, &token)
        .await;
    (result, events)
}

/// A deployment whose first apply ran.
async fn applied(scripted: &Scripted) -> Deployment {
    scripted.set("root.apply", "ok");
    let deployment = scripted.deployment(&missing(scripted));
    assert_not_refused(
        deployment.apply(&original(), &uncancelled()).await,
        "the first apply",
    );
    deployment
}

/// An applied deployment whose OpenTofu state binds storage and authentication,
/// and whose destroy plan deletes authentication and every target but those in
/// `retained`.
async fn applied_with_destroy_plan(scripted: &Scripted, retained: &[&str]) -> Deployment {
    let deployment = applied(scripted).await;
    let targets = compile::runtime_targets(&original(), &scripted.generations()).unwrap();
    let bound: Vec<Target> = targets
        .into_iter()
        .filter(|target| matches!(target.kind.as_str(), STORAGE_KIND | AUTH_KIND))
        .collect();
    scripted.set("root.state", state_json(&bound));
    scripted.set("root.destroy.plan", destroy_plan_json(&bound, retained));
    deployment
}

/// A retried destroy whose OpenTofu state was lost is refused, not reported as
/// finished. The state is the only record of what the interrupted destroy left,
/// so a missing one is not confirmed absence of the resources.
///
/// Catches a retry that treats a deployment with no state as one with nothing
/// left to destroy.
#[tokio::test]
async fn a_kubernetes_destroy_retry_is_refused_when_the_state_was_lost() {
    let scripted = fresh();
    let deployment = applied_with_destroy_plan(&scripted, &[STORAGE]).await;
    let (events, token) = (Events::default(), uncancelled());
    let result = deployment
        .clone()
        .with_progress(events.cancelling(&token, destroying))
        .destroy(&token)
        .await;
    assert_cancelled(result, "destroy cancelled when it began");
    events.assert_mutations(0, "the cancelled destroy");
    let saved = scripted.intent();
    fs::remove_file(scripted.state().join("terraform.tfstate")).unwrap();
    assert_conflict(
        deployment.destroy(&uncancelled()).await,
        "established state is missing",
        "destroy after the state was lost",
    );
    assert_applies(&scripted, 1, "the refused destroy");
    assert_record(&scripted, &saved, "the refused destroy");
}

/// A destroy whose plan would delete the retained storage is refused before the
/// record is marked as destroying, so no apply starts and the refusal blocks no
/// later operation.
///
/// Catches a destroy that applies a plan which deletes the storage it promises
/// to keep, and a refusal that leaves the unfinished-destroy marker set.
#[tokio::test]
async fn a_kubernetes_destroy_plan_that_deletes_retained_storage_is_refused_before_anything_is_applied()
 {
    let scripted = fresh();
    // This destroy plan deletes storage as well as authentication.
    let deployment = applied_with_destroy_plan(&scripted, &[]).await;
    let saved = scripted.intent();
    assert_conflict(
        deployment.destroy(&uncancelled()).await,
        "delete retained data",
        "destroy whose plan deletes the storage",
    );
    assert_applies(&scripted, 1, "the refused plan");
    assert_record(&scripted, &saved, "the refused destroy");
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "export requires all declared resource bindings",
        "export after the refusal is not blocked by an unfinished destroy",
    );
}

/// A cancel before the plan leaves no saved record, so nothing blocks another
/// document.
///
/// Catches a record that is saved before the plan runs.
#[tokio::test]
async fn cancelling_before_the_plan_saves_no_record_and_a_revised_document_is_accepted() {
    let scripted = fresh();
    let kubeconfig = missing(&scripted);
    scripted.set("root.apply", "ok");
    let (result, events) = apply_cancelled_at(&scripted, &original(), &kubeconfig, planning).await;
    assert_cancelled(result, "the first apply cancelled when the plan began");
    events.assert_mutations(0, "the cancelled apply");
    // OpenTofu is not spawned once the token is cancelled, so a logged plan or
    // apply means the cancel did not stop the operation.
    let commands = scripted.commands();
    assert!(
        !commands
            .iter()
            .any(|command| command.ends_with(" plan") || command.ends_with(" apply")),
        "a cancel before the plan still ran it: {commands:?}"
    );
    let deployment = scripted.deployment(&kubeconfig);
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "no saved deployment configuration",
        "export after the cancel",
    );
    assert_not_refused(
        deployment.apply(&another_namespace(), &uncancelled()).await,
        "a revised document is accepted",
    );
    assert_applies(&scripted, 1, "the revised document");
}
