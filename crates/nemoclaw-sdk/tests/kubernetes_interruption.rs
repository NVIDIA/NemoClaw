// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Interrupted and failed operations on a managed Kubernetes deployment leave
//! the state that the next run recovers from (`docs/design/scope.md`, Ownership
//! and Recovery).
//!
//! Each test drives `Deployment` over a bundle whose OpenTofu is a script (see
//! `scripted_tofu`), interrupts or fails one step, and then asks the public
//! operations what the SDK kept: export, plan, apply and destroy either refuse
//! with a reason or proceed. The tests compare the saved record's text before
//! and after an operation; only `Scripted::generations` decodes it, for the
//! tests whose canned bindings must carry the generations of the first apply.
//! The saved record marks an apply or destroy unfinished when it starts to
//! change resources; the tests call that mark the unfinished marker.
//!
//! The OpenShell stage's plan fails unless a test says otherwise, standing in
//! for a provider that cannot reach the gateway, so an operation that no
//! refusal stops fails there; the tests take that failure as proof that the
//! operation was not refused.
//!
//! A test that expects a refusal revises the namespace, which is part of every
//! platform resource's identity, so a rule that admits revisions of unrelated
//! intent still refuses it. A test that expects no refusal revises it too, so
//! that a marker left set refuses it under any such rule; the test whose canned
//! bindings name the namespace revises the name instead.
//!
//! A script stands in for OpenTofu, so these tests establish what the SDK saves
//! and refuses for the results the script returns, not what OpenTofu or the
//! providers do; `nemoclaw-e2e`'s `helm_recovery` runs the bundled ones. The
//! script reports no bindings after a settled runtime stage, so a revision that
//! no marker refuses is not shown to be accepted by a deployment with bindings.
#![cfg(unix)]

use crate::scripted_tofu::{
    Events, Scripted, apply_failed, destroy_plan_json, destroying, kubernetes_document, mid_apply,
    placeholder_generations, plan_json, planning, retained_workspace_state_json, state_json,
};
use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, OperationResult, Outcome, Progress,
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
const WORKSPACE: &str = "openshell_workspace.deployment";

fn original() -> Document {
    kubernetes_document("local-agent", "agents")
}

/// The same deployment on another namespace: another platform identity.
fn another_namespace() -> Document {
    kubernetes_document("local-agent", "other-agents")
}

/// The same platform under another name: the name feeds no resource.
fn renamed(name: &str) -> Document {
    kubernetes_document(name, "agents")
}

/// A scripted OpenTofu for a deployment that was never applied: its runtime
/// plan creates every platform resource.
fn fresh() -> Scripted {
    let scripted = Scripted::new();
    scripted.set("root.planning", "fail");
    let targets = compile::runtime_targets(&original(), &placeholder_generations()).unwrap();
    scripted.set("runtime.apply.plan", plan_json(&targets, "create"));
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

/// The operation reached the OpenShell stage, whose plan failed.
fn assert_reached_openshell<T: Debug>(result: Result<T, Error>, context: &str) {
    assert!(
        matches!(&result, Err(Error::Execution { operation, .. }) if operation == "plan"),
        "{context}: expected the OpenShell stage's plan to fail, got {result:?}"
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

fn assert_runtime_applies(scripted: &Scripted, expected: usize, context: &str) {
    let commands = scripted.commands();
    assert_eq!(
        count(&commands, "runtime apply"),
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

/// No command ran in the OpenShell stage.
fn assert_runtime_only(scripted: &Scripted) {
    let commands = scripted.commands();
    assert!(
        commands
            .iter()
            .all(|command| command.starts_with("runtime ")),
        "the OpenShell stage ran: {commands:?}"
    );
}

/// The OpenTofu call log and the saved record, which a refusal must not change.
struct Untouched {
    calls: Vec<String>,
    record: Option<String>,
}

impl Untouched {
    fn capture(scripted: &Scripted) -> Self {
        Self {
            calls: scripted.calls(),
            record: scripted.intent(),
        }
    }

    fn assert_unchanged(&self, scripted: &Scripted) {
        assert_eq!(scripted.calls(), self.calls, "a refusal ran OpenTofu");
        assert_eq!(
            scripted.intent(),
            self.record,
            "a refusal changed the saved record"
        );
    }
}

/// Apply `document` and cancel at the first event `when` accepts.
async fn apply_cancelled_at(
    scripted: &Scripted,
    document: &Document,
    kubeconfig: &Path,
    when: fn(&Progress) -> bool,
) -> (Result<OperationResult, Error>, Events) {
    let (events, token) = (Events::default(), uncancelled());
    let result = scripted
        .deployment(kubeconfig)
        .with_progress(events.cancelling(&token, when))
        .apply(document, &token)
        .await;
    (result, events)
}

/// The first apply, cancelled while the runtime stage's OpenTofu apply runs. The
/// record was saved before that apply started. Afterwards `runtime.apply` is
/// `fail`.
async fn interrupted_first_apply(scripted: &Scripted, kubeconfig: &Path) {
    scripted.set("runtime.apply", "block");
    let (result, events) = apply_cancelled_at(scripted, &original(), kubeconfig, mid_apply).await;
    assert_cancelled(result, "the first apply");
    events.assert_mutations(1, "the first apply");
    assert_runtime_applies(scripted, 1, "the first apply");
    assert_runtime_only(scripted);
    assert!(
        scripted.record_saved_before_apply("runtime"),
        "OpenTofu started applying before the record marked the apply unfinished"
    );
    // A refusal that failed to refuse would apply again. Let that apply fail at
    // once instead of blocking for the length of the script's sleep.
    scripted.set("runtime.apply", "fail");
}

/// A deployment whose first apply settled the runtime stage and then stopped at
/// the missing kubeconfig.
async fn settled(scripted: &Scripted) -> Deployment {
    scripted.set("runtime.apply", "ok");
    let deployment = scripted.deployment(&missing(scripted));
    assert_reached_openshell(
        deployment.apply(&original(), &uncancelled()).await,
        "the first apply settles the runtime stage",
    );
    deployment
}

/// A settled deployment whose OpenTofu state binds storage and authentication,
/// and whose destroy plan deletes authentication and every target but those in
/// `retained`.
async fn settled_with_destroy_plan(scripted: &Scripted, retained: &[&str]) -> Deployment {
    let deployment = settled(scripted).await;
    let targets = compile::runtime_targets(&original(), &scripted.generations()).unwrap();
    let bound: Vec<Target> = targets
        .into_iter()
        .filter(|target| matches!(target.kind.as_str(), STORAGE_KIND | AUTH_KIND))
        .collect();
    scripted.set("runtime.state", state_json(&bound));
    scripted.set("runtime.destroy.plan", destroy_plan_json(&bound, retained));
    deployment
}

/// A destroy cancelled when its record is saved: no apply ran, and the record
/// says the destroy is unfinished.
async fn destroy_cancelled_when_it_begins(scripted: &Scripted, deployment: &Deployment) {
    let (events, token) = (Events::default(), uncancelled());
    let result = deployment
        .clone()
        .with_progress(events.cancelling(&token, destroying))
        .destroy(&token)
        .await;
    assert_cancelled(result, "destroy cancelled when it began");
    events.assert_mutations(0, "the cancelled destroy");
    assert_runtime_applies(scripted, 1, "the cancelled destroy");
}

/// A cancelled runtime apply can leave resources that no state records. Until
/// an apply of the same document settles the stage, plan and apply of another
/// document, destroy, and export are refused.
///
/// Catches a runtime apply that saves its unfinished marker after OpenTofu has
/// started, or never; a marker that does not bind the saved document; and a
/// rerun that leaves the marker set.
#[tokio::test]
async fn cancelling_the_first_kubernetes_runtime_apply_leaves_an_unfinished_apply_that_only_the_same_document_resumes()
 {
    let scripted = fresh();
    let kubeconfig = missing(&scripted);
    interrupted_first_apply(&scripted, &kubeconfig).await;
    let deployment = scripted.deployment(&kubeconfig);
    let untouched = Untouched::capture(&scripted);

    assert_conflict(
        deployment.plan(&another_namespace(), &uncancelled()).await,
        "requires its original configuration",
        "plan of another namespace",
    );
    assert_conflict(
        deployment.apply(&another_namespace(), &uncancelled()).await,
        "requires its original configuration",
        "apply of another namespace",
    );
    assert_conflict(
        deployment.destroy(&uncancelled()).await,
        "IDs were not saved",
        "destroy",
    );
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "apply is unfinished",
        "export",
    );
    untouched.assert_unchanged(&scripted);

    scripted.set("runtime.apply", "ok");
    assert_reached_openshell(
        deployment.apply(&original(), &uncancelled()).await,
        "the same document settles the runtime stage and stops at the OpenShell stage's plan",
    );
    assert_runtime_applies(&scripted, 2, "the same document");
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "export requires all declared resource bindings",
        "export after the runtime settled is no longer refused as unfinished",
    );
}

/// A destroy that is cancelled after its record is saved blocks apply and plan
/// until destroy runs again. The retry plans only the stage that is left, and it
/// connects to no cluster: the OpenShell stage is done even though its state
/// still holds the retained workspace.
///
/// Catches a destroy that does not block apply; a retry that connects to the
/// cluster, or plans the OpenShell stage again, after that stage finished; a
/// retry that applies the runtime stage more than once; and a result that omits
/// the retained storage or workspace.
#[tokio::test]
async fn an_interrupted_kubernetes_destroy_blocks_apply_and_its_retry_makes_no_connection_once_the_openshell_stage_is_done()
 {
    let scripted = fresh();
    // A destroy plan that deletes authentication and keeps storage, the
    // namespace and its key.
    let deployment = settled_with_destroy_plan(&scripted, &[STORAGE]).await;
    destroy_cancelled_when_it_begins(&scripted, &deployment).await;
    let untouched = Untouched::capture(&scripted);
    assert_conflict(
        deployment.apply(&original(), &uncancelled()).await,
        "unfinished destroy",
        "apply after the interrupted destroy",
    );
    assert_conflict(
        deployment.plan(&original(), &uncancelled()).await,
        "unfinished destroy",
        "plan after the interrupted destroy",
    );
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "destroy is unfinished",
        "export after the interrupted destroy",
    );
    untouched.assert_unchanged(&scripted);

    // The OpenShell stage kept its workspace binding. The retry must still treat
    // that stage as finished, which it can only do from the saved record: a
    // connection attempt would stop at the missing kubeconfig.
    fs::write(
        scripted.state().join("terraform.tfstate"),
        r#"{"version":4,"resources":[]}"#,
    )
    .unwrap();
    scripted.set("root.state", retained_workspace_state_json());
    let before = scripted.commands().len();

    let destroyed = deployment
        .destroy(&uncancelled())
        .await
        .expect("the retry must finish without a connection");

    assert_eq!(
        destroyed.outcome,
        Outcome::Destroyed,
        "the retry must report the destroy as finished"
    );
    for kept in [STORAGE, WORKSPACE] {
        assert!(
            destroyed.retained.iter().any(|address| address == kept),
            "{kept} is not reported as retained: {:?}",
            destroyed.retained
        );
    }
    let retry = &scripted.commands()[before..];
    let root_runs = count(retry, "root plan") + count(retry, "root apply");
    assert_eq!(
        root_runs, 0,
        "the retry ran the finished OpenShell stage: {retry:?}"
    );
    assert_eq!(count(retry, "runtime apply"), 1, "{retry:?}");
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "destroyed deployment",
        "export after the destroy finished",
    );
}

/// A retried destroy whose OpenTofu state was lost is refused, not reported as
/// finished. The state is the only record of what the interrupted destroy left,
/// so a missing one is not confirmed absence of the resources.
///
/// Catches a retry that treats a stage with no state as one with nothing left to
/// destroy.
#[tokio::test]
async fn a_kubernetes_destroy_retry_is_refused_when_the_runtime_state_was_lost() {
    let scripted = fresh();
    let deployment = settled_with_destroy_plan(&scripted, &[STORAGE]).await;
    destroy_cancelled_when_it_begins(&scripted, &deployment).await;
    let saved = scripted.intent();
    fs::remove_file(scripted.state().join("runtime/terraform.tfstate")).unwrap();

    assert_conflict(
        deployment.destroy(&uncancelled()).await,
        "established state is missing",
        "destroy after the runtime state was lost",
    );

    assert_runtime_applies(&scripted, 1, "the refused destroy");
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
    let deployment = settled_with_destroy_plan(&scripted, &[]).await;
    let saved = scripted.intent();

    assert_conflict(
        deployment.destroy(&uncancelled()).await,
        "delete retained data",
        "destroy whose plan deletes the storage",
    );

    assert_runtime_applies(&scripted, 1, "the refused plan");
    assert_record(&scripted, &saved, "the refused destroy");
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "export requires all declared resource bindings",
        "export after the refusal is not blocked by an unfinished destroy",
    );
}

/// A runtime apply that fails leaves the same unfinished state as a cancelled
/// one, because OpenTofu can create resources before it fails. The failure keeps
/// its diagnostic, destroy and a revised document stay refused, and the same
/// document settles the stage.
///
/// Catches a failed apply that clears the unfinished marker, a failed apply that
/// saves its marker only after OpenTofu returns, and a failure that loses
/// OpenTofu's diagnostic.
#[tokio::test]
async fn a_failed_first_kubernetes_runtime_apply_leaves_an_unfinished_apply_that_only_the_same_document_resumes()
 {
    let scripted = fresh();
    let kubeconfig = missing(&scripted);
    scripted.set("runtime.apply", "fail");
    let events = Events::default();
    let deployment = scripted.deployment(&kubeconfig);

    let result = deployment
        .clone()
        .with_progress(events.recording())
        .apply(&original(), &uncancelled())
        .await;

    let Err(Error::Execution {
        operation,
        diagnostic,
        ..
    }) = result
    else {
        panic!("expected the OpenTofu apply to fail, got {result:?}");
    };
    assert_eq!(operation, "apply", "the failure must come from the apply");
    assert!(
        diagnostic.contains("provider failed"),
        "the failure lost OpenTofu's message: {diagnostic:?}"
    );
    assert!(
        events.contains(apply_failed),
        "no failed tofu.apply step was reported"
    );
    assert!(
        scripted.record_saved_before_apply("runtime"),
        "OpenTofu started applying before the record marked the apply unfinished"
    );
    let untouched = Untouched::capture(&scripted);
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "apply is unfinished",
        "export after the failed apply",
    );
    assert_conflict(
        deployment.destroy(&uncancelled()).await,
        "IDs were not saved",
        "destroy after the failed apply",
    );
    assert_conflict(
        deployment.apply(&another_namespace(), &uncancelled()).await,
        "requires its original configuration",
        "apply of another namespace after the failed apply",
    );
    untouched.assert_unchanged(&scripted);

    scripted.set("runtime.apply", "ok");
    assert_reached_openshell(
        deployment.apply(&original(), &uncancelled()).await,
        "the same document settles the runtime stage and stops at the OpenShell stage's plan",
    );
    assert_conflict(
        deployment.export(&uncancelled()).await,
        "export requires all declared resource bindings",
        "export after the runtime settled is no longer refused as unfinished",
    );
}

/// A cancel before the runtime stage plans leaves no saved record, so nothing
/// blocks another document.
///
/// Catches a record that is saved before the runtime plan runs.
#[tokio::test]
async fn cancelling_before_the_runtime_mutation_saves_no_record_and_a_revised_document_is_accepted()
{
    let scripted = fresh();
    let kubeconfig = missing(&scripted);
    scripted.set("runtime.apply", "ok");

    let (result, events) = apply_cancelled_at(&scripted, &original(), &kubeconfig, planning).await;

    assert_cancelled(
        result,
        "the first apply cancelled when the runtime plan began",
    );
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

    assert_reached_openshell(
        deployment.apply(&another_namespace(), &uncancelled()).await,
        "a revised document is accepted and settles the runtime stage",
    );
    assert_runtime_applies(&scripted, 1, "the revised document");
}

/// A runtime stage that changes nothing still runs its apply, but it sets no
/// unfinished marker, because no resource is at risk, and it does not save the
/// proposed document, because the proposed OpenShell intent must not be
/// committed before its plan is accepted. The saved record stays as it was, so
/// the next operation is not blocked.
///
/// Catches an unfinished marker, or a saved proposal, for a runtime plan that
/// changes nothing, and an unchanged runtime stage that skips its apply.
#[tokio::test]
async fn cancelling_an_unchanged_kubernetes_runtime_apply_keeps_the_saved_document_and_leaves_no_unfinished_apply()
 {
    let scripted = fresh();
    let kubeconfig = missing(&scripted);
    let deployment = settled(&scripted).await;
    // The runtime matches the document: every binding exists and the plan
    // changes nothing.
    let targets = compile::runtime_targets(&original(), &scripted.generations()).unwrap();
    scripted.set("runtime.state", state_json(&targets));
    scripted.set("runtime.apply.plan", plan_json(&targets, "no-op"));
    scripted.set("runtime.apply", "block");
    let saved = scripted.intent();

    let (result, events) =
        apply_cancelled_at(&scripted, &renamed("renamed-agent"), &kubeconfig, mid_apply).await;

    assert_cancelled(result, "the unchanged runtime apply");
    events.assert_mutations(1, "the unchanged runtime stage");
    assert_record(&scripted, &saved, "the cancelled apply");

    scripted.set("runtime.apply", "ok");
    assert_reached_openshell(
        deployment
            .apply(&renamed("another-name"), &uncancelled())
            .await,
        "a revised document is accepted after the cancel",
    );
    assert_record(&scripted, &saved, "the accepted revision");
}

/// A revised document after an interrupted platform apply is refused before
/// OpenTofu plans or applies anything, also when the OpenShell stage has state.
/// The refusal changes neither the record nor that state.
///
/// Catches a refusal that moves after a plan or an apply, a refusal that skips
/// a stage that has bindings, and a refusal that saves or rewrites state first.
#[tokio::test]
async fn a_revised_document_after_an_interrupted_kubernetes_apply_is_refused_before_any_plan_or_apply()
 {
    let scripted = fresh();
    let kubeconfig = missing(&scripted);
    interrupted_first_apply(&scripted, &kubeconfig).await;
    let state = scripted.state().join("terraform.tfstate");
    fs::write(&state, r#"{"version":4,"resources":[]}"#).unwrap();
    scripted.set("root.state", retained_workspace_state_json());
    let (saved, openshell_state) = (scripted.intent(), fs::read(&state).unwrap());
    let before = scripted.commands().len();
    let deployment = scripted.deployment(&kubeconfig);

    assert_conflict(
        deployment.plan(&another_namespace(), &uncancelled()).await,
        "requires its original configuration",
        "plan of another namespace",
    );
    assert_conflict(
        deployment.apply(&another_namespace(), &uncancelled()).await,
        "requires its original configuration",
        "apply of another namespace",
    );

    // The refusal may read the OpenShell stage's state (`root init`, `root
    // show`); it must not touch the runtime stage, plan, or apply.
    let started: Vec<_> = scripted.commands()[before..]
        .iter()
        .filter(|command| {
            command.starts_with("runtime ")
                || command.ends_with(" plan")
                || command.ends_with(" apply")
        })
        .cloned()
        .collect();
    assert!(started.is_empty(), "the refusal came after {started:?}");
    assert_record(&scripted, &saved, "a refusal");
    assert_eq!(
        fs::read(&state).unwrap(),
        openshell_state,
        "a refusal changed the OpenShell state"
    );
}
