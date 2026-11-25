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

use nemoclaw_sdk::{Change, Progress, config::Document};
use record::{Effect, FailureStage, NvidiaSource, Operation, Outcome, Record};
use std::sync::{Arc, Mutex};

/// A finished command's `outcome`, `effect` and `failureStage`.
pub type Ended = (Outcome, Effect, FailureStage);

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

    /// A command that failed or was cancelled: its failure stage is the last
    /// stage event, `validate` before any.
    pub fn failed(&self, cancelled: bool) -> Ended {
        let stage = self.0.lock().ok().and_then(|last| *last);
        let outcome = if cancelled {
            Outcome::Cancelled
        } else {
            Outcome::Failed
        };
        (
            outcome,
            Effect::Other,
            stage.unwrap_or(FailureStage::Validate),
        )
    }
}

/// A command that succeeded, with the `effect` of its changes.
pub fn succeeded(operation: Operation, changes: &[Change]) -> Ended {
    let actions = || changes.iter().flat_map(|change| change.actions.iter());
    let effect = match operation {
        Operation::Onboard => Effect::Authored,
        Operation::Destroy => Effect::Teardown,
        Operation::Apply if actions().all(|action| matches!(action.as_str(), "no-op" | "read")) => {
            Effect::None
        }
        Operation::Apply if actions().all(|action| action == "create") => Effect::Initial,
        Operation::Apply => Effect::Update,
        Operation::Other => Effect::Other,
    };
    (Outcome::Succeeded, effect, FailureStage::None)
}

/// Sends the record of a finished command when `label` (from [`gate::check`])
/// allows it. `document` is the one the command read, or wrote for `onboard`.
pub async fn report(
    label: Option<String>,
    operation: Operation,
    ended: Ended,
    duration: std::time::Duration,
    document: Option<&Document>,
) {
    let Some(label) = label else { return };
    let identity = identity::load(identity::directory().as_deref(), record::build().0);
    let host = host::detect();
    let record = build(operation, ended, duration, document, label, identity, host);
    send::send(&record).await;
}

fn build(
    operation: Operation,
    (outcome, effect, failure_stage): Ended,
    duration: std::time::Duration,
    document: Option<&Document>,
    test_label: String,
    identity: identity::Identity,
    host: host::Host,
) -> Record {
    let (version, build_kind) = record::build();
    let config = project::config(document);
    Record {
        nvidia_source: NvidiaSource::Nemoclaw,
        install_id: identity.install_id,
        first_run: identity.first_run,
        test_label,
        build_kind,
        version: version.into(),
        previous_version: identity.previous_version,
        operation,
        outcome,
        effect,
        failure_stage,
        duration_ms: u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
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

#[cfg(test)]
mod tests {
    use super::*;
    use record::{Arch, Cloud, ComputeDriver, DeploymentSource, Hardware, HostContext, Os};

    fn change(actions: &[&str]) -> Change {
        Change {
            resource: "r".into(),
            actions: actions.iter().map(|action| action.to_string()).collect(),
            reason: None,
        }
    }

    #[test]
    fn effect_follows_the_change_actions() {
        let effect = |operation, changes: &[Change]| succeeded(operation, changes).1;
        let (noop, read, create) = (change(&["no-op"]), change(&["read"]), change(&["create"]));
        for (changes, expected) in [
            (vec![], Effect::None),
            (vec![noop.clone(), read], Effect::None),
            (vec![create.clone(), create.clone()], Effect::Initial),
            (vec![create.clone(), noop], Effect::Update),
            (vec![change(&["update"])], Effect::Update),
            (vec![change(&["delete", "create"])], Effect::Update),
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
        let failed_at = || stage.failed(false).2;
        assert_eq!(failed_at(), FailureStage::Validate);
        for (event, expected) in [
            (Progress::Validating, FailureStage::Initialize),
            (Progress::Planning, FailureStage::Plan),
            (Progress::MutationStarted, FailureStage::Plan),
            (Progress::Applying, FailureStage::Apply),
            (Progress::Readiness, FailureStage::Finish),
            (Progress::Destroying, FailureStage::Destroy),
        ] {
            progress(event);
            assert_eq!(failed_at(), expected);
        }
        assert_eq!(
            stage.failed(true),
            (Outcome::Cancelled, Effect::Other, FailureStage::Destroy)
        );
    }

    #[test]
    fn a_saving_onboard_sends_an_authored_record_with_its_configuration() {
        let document = Document::parse(
            include_bytes!("../../../../examples/onboarding/openclaw.yaml").as_slice(),
        )
        .unwrap();
        let identity = identity::Identity {
            install_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            first_run: true,
            previous_version: "none".into(),
        };
        let host = host::Host {
            os: Os::Linux,
            arch: Arch::Arm64,
            host_context: HostContext::Native,
            deployment_source: DeploymentSource::None,
            cloud: Cloud::None,
            hardware: Hardware::Unknown,
        };
        let record = build(
            Operation::Onboard,
            succeeded(Operation::Onboard, &[]),
            std::time::Duration::from_millis(1500),
            Some(&document),
            String::new(),
            identity,
            host,
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
}
