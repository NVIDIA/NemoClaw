// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The telemetry record of schema 5.0 and its sender, defined in
//! `internal-docs/design/telemetry.md`: one flat record when `apply`, `destroy`,
//! or a configuration-writing `onboard` finishes.
#![allow(
    dead_code,
    reason = "every closed list keeps `other` for the schema, and tests read `record::schema`"
)]

pub mod gate;
mod host;
pub mod identity;
pub mod project;
pub mod record;
pub mod send;

use nemoclaw_sdk::{Progress, config::Document};
use record::{Effect, FailureStage, NvidiaSource, Operation, Outcome, Record};
use std::sync::{Arc, Mutex};

/// The last stage event a command emitted, for `failureStage`.
#[derive(Clone, Default)]
pub struct Stage(Arc<Mutex<Option<FailureStage>>>);

impl Stage {
    /// Passes every event on to `inner`, keeping the stage events.
    pub fn watch(
        &self,
        inner: Arc<dyn Fn(Progress) + Send + Sync>,
    ) -> Arc<dyn Fn(Progress) + Send + Sync> {
        let last = self.0.clone();
        Arc::new(move |event| {
            let stage = match event {
                Progress::Validating => Some(FailureStage::Initialize),
                Progress::Planning => Some(FailureStage::Plan),
                Progress::Applying => Some(FailureStage::Apply),
                Progress::Readiness => Some(FailureStage::Finish),
                Progress::Destroying => Some(FailureStage::Destroy),
                Progress::Exporting => Some(FailureStage::Other),
                _ => None,
            };
            if let Some(stage) = stage
                && let Ok(mut last) = last.lock()
            {
                *last = Some(stage);
            }
            inner(event);
        })
    }

    /// The failure stage of a command that failed now: `validate` before any stage event.
    fn failed_at(&self) -> FailureStage {
        self.0
            .lock()
            .ok()
            .and_then(|last| *last)
            .unwrap_or(FailureStage::Validate)
    }
}

/// How a command that may send a record ended.
pub enum Ended {
    /// The OpenTofu actions of each change of a finished `apply` or `destroy`.
    Succeeded(Vec<Vec<String>>),
    Failed,
    Cancelled,
}

/// A finished command, with the document it read (or wrote, for `onboard`).
pub struct Finished<'a> {
    pub operation: Operation,
    pub ended: Ended,
    pub stage: &'a Stage,
    pub duration: std::time::Duration,
    pub document: Option<&'a Document>,
}

/// Sends the record of `finished` when `label` (from [`gate::check`]) allows it.
pub async fn report(label: Option<String>, finished: Finished<'_>) {
    let Some(label) = label else { return };
    let (version, build_kind) = record::build();
    let identity = identity::load(identity::directory().as_deref(), version);
    send::send(&build(
        finished,
        label,
        version,
        build_kind,
        identity,
        host::detect(),
    ))
    .await;
}

fn build(
    finished: Finished<'_>,
    test_label: String,
    version: &str,
    build_kind: record::BuildKind,
    identity: identity::Identity,
    host: host::Host,
) -> Record {
    let (outcome, effect, failure_stage) = match &finished.ended {
        Ended::Succeeded(changes) => (
            Outcome::Succeeded,
            effect(finished.operation, changes),
            FailureStage::None,
        ),
        Ended::Failed => (Outcome::Failed, Effect::Other, finished.stage.failed_at()),
        Ended::Cancelled => (
            Outcome::Cancelled,
            Effect::Other,
            finished.stage.failed_at(),
        ),
    };
    let config = project::config(finished.document);
    Record {
        nvidia_source: NvidiaSource::Nemoclaw,
        install_id: identity.install_id,
        first_run: identity.first_run,
        test_label,
        build_kind,
        version: version.into(),
        previous_version: identity.previous_version,
        operation: finished.operation,
        outcome,
        effect,
        failure_stage,
        duration_ms: u64::try_from(finished.duration.as_millis()).unwrap_or(u64::MAX),
        os: host.os,
        arch: host.arch,
        host_context: host.host_context,
        deployment_source: host.deployment_source,
        cloud: host.cloud,
        hardware: host.hardware,
        harnesses: config.harnesses,
        models: config.models,
        inference_hosts: config.inference_hosts,
        compute_driver: config.compute_driver,
        sandbox_count: config.sandbox_count,
        agent_count: config.agent_count,
        web_search: config.web_search,
        mcp_configured: config.mcp_configured,
    }
}

/// The `effect` of a command that succeeded, from the actions of its changes.
fn effect(operation: Operation, changes: &[Vec<String>]) -> Effect {
    let actions = || changes.iter().flat_map(|actions| actions.iter());
    match operation {
        Operation::Onboard => Effect::Authored,
        Operation::Destroy => Effect::Teardown,
        Operation::Apply if actions().all(|action| matches!(action.as_str(), "no-op" | "read")) => {
            Effect::None
        }
        Operation::Apply if actions().all(|action| action == "create") => Effect::Initial,
        Operation::Apply => Effect::Update,
        Operation::Other => Effect::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use record::{Arch, Cloud, ComputeDriver, DeploymentSource, Hardware, HostContext, Os};

    fn actions(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    #[test]
    fn apply_effect_follows_the_change_actions() {
        let (noop, read, create, update) = (
            actions(&["no-op"]),
            actions(&["read"]),
            actions(&["create"]),
            actions(&["update"]),
        );
        let replace = actions(&["delete", "create"]);
        for (changes, expected) in [
            (vec![], Effect::None),
            (vec![noop.clone(), read], Effect::None),
            (vec![create.clone(), create.clone()], Effect::Initial),
            (vec![create.clone(), noop], Effect::Update),
            (vec![update], Effect::Update),
            (vec![replace], Effect::Update),
        ] {
            assert_eq!(effect(Operation::Apply, &changes), expected, "{changes:?}");
        }
        assert_eq!(effect(Operation::Destroy, &[create]), Effect::Teardown);
        assert_eq!(effect(Operation::Onboard, &[]), Effect::Authored);
    }

    #[test]
    fn failure_stage_is_the_last_stage_event() {
        let stage = Stage::default();
        let progress = stage.watch(Arc::new(|_| {}));
        assert_eq!(stage.failed_at(), FailureStage::Validate);
        for (event, expected) in [
            (Progress::Validating, FailureStage::Initialize),
            (Progress::Planning, FailureStage::Plan),
            (Progress::MutationStarted, FailureStage::Plan),
            (Progress::Applying, FailureStage::Apply),
            (Progress::Readiness, FailureStage::Finish),
            (Progress::Destroying, FailureStage::Destroy),
        ] {
            progress(event);
            assert_eq!(stage.failed_at(), expected);
        }
    }

    fn host() -> host::Host {
        host::Host {
            os: Os::Linux,
            arch: Arch::Arm64,
            host_context: HostContext::Native,
            deployment_source: DeploymentSource::None,
            cloud: Cloud::None,
            hardware: Hardware::Unknown,
        }
    }

    fn identity() -> identity::Identity {
        identity::Identity {
            install_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            first_run: true,
            previous_version: "none".into(),
        }
    }

    #[test]
    fn a_saving_onboard_sends_an_authored_record_with_its_configuration() {
        let document = Document::parse(
            include_bytes!("../../../../examples/onboarding/openclaw.yaml").as_slice(),
        )
        .unwrap();
        let stage = Stage::default();
        let record = build(
            Finished {
                operation: Operation::Onboard,
                ended: Ended::Succeeded(vec![]),
                stage: &stage,
                duration: std::time::Duration::from_millis(1500),
                document: Some(&document),
            },
            String::new(),
            "1.0.0",
            record::BuildKind::Release,
            identity(),
            host(),
        );
        assert_eq!(record.operation, Operation::Onboard);
        assert_eq!(record.outcome, Outcome::Succeeded);
        assert_eq!(record.effect, Effect::Authored);
        assert_eq!(record.failure_stage, FailureStage::None);
        assert_eq!(record.duration_ms, 1500);
        assert_eq!(record.compute_driver, ComputeDriver::Docker);
        assert_eq!(
            record.harnesses,
            ["nvidia.fabric.openclaw".to_string()].into()
        );
    }

    #[test]
    fn a_failure_without_a_document_sends_the_unread_configuration() {
        let stage = Stage::default();
        stage.watch(Arc::new(|_| {}))(Progress::Planning);
        let record = build(
            Finished {
                operation: Operation::Destroy,
                ended: Ended::Cancelled,
                stage: &stage,
                duration: std::time::Duration::ZERO,
                document: None,
            },
            "qa-run:case:attempt-1".into(),
            "1.0.0-dev",
            record::BuildKind::Dev,
            identity(),
            host(),
        );
        assert_eq!(record.outcome, Outcome::Cancelled);
        assert_eq!(record.effect, Effect::Other);
        assert_eq!(record.failure_stage, FailureStage::Plan);
        assert_eq!(record.compute_driver, ComputeDriver::Unknown);
        assert!(record.harnesses.is_empty());
        assert_eq!(record.test_label, "qa-run:case:attempt-1");
    }
}
