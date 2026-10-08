// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::support;

use async_trait::async_trait;
use nemoclaw_provider::{Backend, Mutation, ResourceAdapter, Row, State};
use nemoclaw_sdk::ObservationError;
use std::sync::Arc;
use tf_provider::{Diagnostics, Resource, value::Value};

struct Fixture(Result<Option<Row>, ObservationError>);
#[async_trait]
impl Backend for Fixture {
    async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
        self.0.clone()
    }
    async fn ensure(&self, _: &str, _: &Row) -> Mutation {
        panic!("refresh cannot mutate")
    }
    async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
        panic!("refresh cannot delete")
    }
}
fn row() -> Row {
    [
        ("id", "physical"),
        ("name", "workspace"),
        ("owner", "deployment"),
        ("generation", "generation"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}
fn state(row: Row) -> State {
    row.into_iter().map(|(k, v)| (k, Value::Value(v))).collect()
}

#[tokio::test]
async fn kubernetes_storage_absence_and_destroy_preserve_its_binding() {
    let resource = ResourceAdapter::new(
        support::definition("kubernetes_storage", &["spec", "running"], &["running"]),
        Arc::new(Fixture(Ok(None))),
    );
    let prior = state(Row::from([
        ("id".into(), "namespace-and-storage-binding".into()),
        ("spec".into(), "retained-spec".into()),
        ("running".into(), "false".into()),
    ]));
    for destroying in [false, true] {
        resource
            .destroying
            .store(destroying, std::sync::atomic::Ordering::Release);
        let mut diagnostics = Diagnostics::default();
        let observed = resource
            .read(&mut diagnostics, prior.clone(), Value::Null, Value::Null)
            .await
            .unwrap();
        assert_eq!(observed.0, prior);
        assert!(!diagnostics.errors.is_empty());
        let mut diagnostics = Diagnostics::default();
        assert!(
            resource
                .plan_destroy(&mut diagnostics, prior.clone(), Value::Null, Value::Null)
                .await
                .is_none()
        );
        assert!(!diagnostics.errors.is_empty());
    }
}

#[tokio::test]
async fn teardown_does_not_resume_incomplete_retained_kubernetes_storage() {
    use nemoclaw_sdk::{compile, config::Document};
    let document = Document::parse(
        include_bytes!("../../../examples/kubernetes/managed-development.yaml").as_slice(),
    )
    .unwrap();
    let generations = ["kubernetes_storage", "kubernetes_gateway"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let mut row = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "kubernetes_storage")
        .unwrap()
        .values;
    let fields: Vec<_> = nemoclaw_sdk::kubernetes::ATTRIBUTES
        .into_iter()
        .chain(["running"])
        .collect();
    let resource = ResourceAdapter::new(
        support::definition("kubernetes_storage", &fields, &["running"]),
        Arc::new(Fixture(Ok(None))),
    );
    row.insert("id".into(), "retained-storage".into());
    row.insert("running".into(), "false".into());
    let prior = state(row);
    for destroying in [false, true] {
        resource
            .destroying
            .store(destroying, std::sync::atomic::Ordering::Release);
        let mut diagnostics = Diagnostics::default();
        let planned = resource
            .plan_update(
                &mut diagnostics,
                prior.clone(),
                prior.clone(),
                prior.clone(),
                Value::Null,
                Value::Null,
            )
            .await
            .unwrap();
        assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
        assert!(planned.2.is_empty());
        assert_eq!(planned.0["id"], prior["id"]);
        assert_eq!(
            planned.0["running"],
            if destroying {
                Value::Value("false".into())
            } else {
                Value::Unknown
            }
        );
    }
}

#[tokio::test]
async fn omitted_optional_computed_values_get_defaults_when_the_proposed_value_is_unknown() {
    let resource = ResourceAdapter::new(
        support::definition(
            "provider",
            &["name", "endpoint", "credential_env"],
            &["endpoint", "credential_env"],
        ),
        Arc::new(Fixture(Ok(None))),
    );
    let config = State::from([
        ("name".into(), Value::Value("inference".into())),
        (
            "endpoint".into(),
            Value::Value("https://example.test/v1".into()),
        ),
        ("credential_env".into(), Value::Null),
    ]);
    let mut proposed = config.clone();
    proposed.insert("credential_env".into(), Value::Unknown);
    let mut diagnostics = Diagnostics::default();
    let result = resource
        .plan_create(&mut diagnostics, proposed, config, Value::Null)
        .await;
    assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
    assert_eq!(
        result.unwrap().0["credential_env"],
        Value::Value(String::new())
    );
}

#[tokio::test]
async fn removing_image_pull_policy_restores_the_default_without_replacement() {
    let resource = ResourceAdapter::new(
        support::definition(
            "managed_gateway",
            &["spec", "running", "image_pull_policy"],
            &["running", "image_pull_policy"],
        ),
        Arc::new(Fixture(Ok(None))),
    );
    let encoded = support::specification("managed_gateway").to_string();
    let prior: State = [
        ("id", "physical"),
        ("spec", encoded.as_str()),
        ("running", "true"),
        ("image_pull_policy", "Always"),
    ]
    .map(|(key, value)| (key.into(), Value::Value(value.into())))
    .into();
    let mut config = prior.clone();
    config.insert("image_pull_policy".into(), Value::Null);
    let mut diagnostics = Diagnostics::default();
    let (planned, _, replacements) = resource
        .plan_update(
            &mut diagnostics,
            prior.clone(),
            prior.clone(),
            config,
            Value::Null,
            Value::Null,
        )
        .await
        .unwrap();
    assert!(diagnostics.errors.is_empty());
    assert!(replacements.is_empty());
    assert_eq!(planned["id"], prior["id"]);
    assert_eq!(planned["image_pull_policy"], Value::Value(String::new()));
}

#[tokio::test]
async fn failed_and_partial_observations_retain_protocol_state() {
    let mut partial = row();
    partial.remove("id");
    let mut foreign = row();
    foreign.insert("owner".into(), "someone-else".into());
    for kind in [
        "workspace",
        "provider_profile",
        "provider",
        "sandbox",
        "agent_configuration",
    ] {
        for observation in [
            Err(ObservationError::Transport),
            Ok(Some(partial.clone())),
            Ok(Some(foreign.clone())),
        ] {
            let resource = ResourceAdapter::new(
                support::definition(kind, &["name", "owner", "generation"], &[]),
                Arc::new(Fixture(observation)),
            );
            let mut diagnostics = Diagnostics::default();
            let original = state(row());
            let result = resource
                .read(&mut diagnostics, original.clone(), Value::Null, Value::Null)
                .await;
            assert!(!diagnostics.errors.is_empty(), "{kind}");
            assert_eq!(result.unwrap().0, original, "{kind}");
        }
    }
}

#[tokio::test]
async fn confirmed_absence_reconciles_registrations_but_preserves_stateful_bindings() {
    for kind in [
        "workspace",
        "provider_profile",
        "provider",
        "sandbox",
        "agent_configuration",
    ] {
        for destroying in [false, true] {
            let resource = ResourceAdapter::new(
                support::definition(kind, &["name", "owner", "generation"], &[]),
                Arc::new(Fixture(Ok(None))),
            );
            resource
                .destroying
                .store(destroying, std::sync::atomic::Ordering::Release);
            let mut diagnostics = Diagnostics::default();
            let prior = state(row());
            let result = resource
                .read(&mut diagnostics, prior.clone(), Value::Null, Value::Null)
                .await;
            if matches!(
                kind,
                "provider_profile" | "provider" | "agent_configuration"
            ) || (destroying && kind == "sandbox")
            {
                assert!(result.is_none());
                assert!(diagnostics.errors.is_empty());
            } else {
                assert_eq!(result.unwrap().0, prior);
                assert!(!diagnostics.errors.is_empty());
            }
        }
    }
}

struct CreatedIncomplete;
#[async_trait]
impl Backend for CreatedIncomplete {
    async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
        unreachable!()
    }
    async fn ensure(&self, _: &str, _: &Row) -> Mutation {
        Mutation::complete(Row::new())
    }
    async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
        unreachable!()
    }
}

#[tokio::test]
async fn incomplete_mutation_results_fail_without_overwriting_established_identity() {
    let resource = ResourceAdapter::new(
        support::definition("workspace", &["name", "owner", "generation"], &[]),
        Arc::new(CreatedIncomplete),
    );
    let mut diagnostics = Diagnostics::default();
    let original = state(row());
    let result = resource
        .update(
            &mut diagnostics,
            original.clone(),
            original.clone(),
            original.clone(),
            Value::Null,
            Value::Null,
        )
        .await
        .unwrap();
    assert!(!diagnostics.errors.is_empty());
    assert_eq!(result.0, original);
}

struct ExitedAfterStart;
#[async_trait]
impl Backend for ExitedAfterStart {
    async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
        unreachable!()
    }
    async fn ensure(&self, _: &str, desired: &Row) -> Mutation {
        let mut row = desired.clone();
        row.insert("id".into(), "established-container".into());
        row.insert("running".into(), "false".into());
        Mutation::complete(row)
    }
    async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
        unreachable!()
    }
}
#[tokio::test]
async fn immediate_exit_establishes_state_and_restart_preserves_identity() {
    let resource = ResourceAdapter::new(
        support::definition("managed_gateway", &["spec", "running"], &["running"]),
        Arc::new(ExitedAfterStart),
    );
    let mut diagnostics = Diagnostics::default();
    let configured = State::from([
        (
            "spec".into(),
            Value::Value(support::specification("managed_gateway").to_string()),
        ),
        ("running".into(), Value::Null),
        ("id".into(), Value::Null),
    ]);
    let (planned, _) = resource
        .plan_create(
            &mut diagnostics,
            configured.clone(),
            configured.clone(),
            Value::Null,
        )
        .await
        .unwrap();
    assert!(matches!(planned["running"], Value::Unknown));
    let (created, _) = resource
        .create(
            &mut diagnostics,
            planned,
            configured.clone(),
            Value::Null,
            Value::Null,
        )
        .await
        .unwrap();
    assert!(diagnostics.errors.is_empty());
    assert_eq!(created["id"], Value::Value("established-container".into()));
    assert_eq!(created["running"], Value::Value("false".into()));
    let (planned, _, replacements) = resource
        .plan_update(
            &mut diagnostics,
            created.clone(),
            created.clone(),
            configured.clone(),
            Value::Null,
            Value::Null,
        )
        .await
        .unwrap();
    assert!(replacements.is_empty());
    let (restarted, _) = resource
        .update(
            &mut diagnostics,
            created.clone(),
            planned,
            configured,
            Value::Null,
            Value::Null,
        )
        .await
        .unwrap();
    assert!(diagnostics.errors.is_empty());
    assert_eq!(restarted, created);
}

#[tokio::test]
async fn reconstructible_resources_plan_replacement_and_deletion_without_teardown_mode() {
    for kind in [
        "workspace",
        "provider_profile",
        "provider",
        "sandbox",
        "agent_configuration",
    ] {
        let resource = ResourceAdapter::new(
            support::definition(kind, &["name", "owner", "generation"], &[]),
            Arc::new(Fixture(Ok(None))),
        );
        let prior = state(row());
        let mut changed = prior.clone();
        changed.insert("name".into(), Value::Value("replacement".into()));
        let mut diagnostics = Diagnostics::default();
        let result = resource
            .plan_update(
                &mut diagnostics,
                prior.clone(),
                changed.clone(),
                changed,
                Value::Null,
                Value::Null,
            )
            .await;
        let reconstructible = matches!(
            kind,
            "provider_profile" | "provider" | "agent_configuration"
        );
        assert_eq!(result.is_some(), reconstructible, "{kind}");
        assert_eq!(diagnostics.errors.is_empty(), reconstructible, "{kind}");
        if let Some((_, _, replacements)) = result {
            assert_eq!(replacements.len(), 1, "{kind}");
        }
        for destroying in [false, true] {
            resource
                .destroying
                .store(destroying, std::sync::atomic::Ordering::Release);
            let mut diagnostics = Diagnostics::default();
            let result = resource
                .plan_destroy(&mut diagnostics, prior.clone(), Value::Null, Value::Null)
                .await;
            let allowed = reconstructible || (destroying && kind == "sandbox");
            assert_eq!(result.is_some(), allowed, "{kind}, destroy={destroying}");
            assert_eq!(
                diagnostics.errors.is_empty(),
                allowed,
                "{kind}, destroy={destroying}"
            );
        }
    }
}

#[tokio::test]
async fn retained_replacement_refusal_names_the_resource_and_changed_fields() {
    let resource = ResourceAdapter::new(
        support::definition(
            "sandbox",
            &["name", "workspace", "owner", "generation"],
            &[],
        ),
        Arc::new(Fixture(Ok(None))),
    );
    let mut prior = state(row());
    prior.insert("name".into(), Value::Value("reviewer".into()));
    prior.insert(
        "workspace".into(),
        Value::Value("PRIVATE_OLD_WORKSPACE".into()),
    );
    let mut changed = prior.clone();
    changed.insert(
        "workspace".into(),
        Value::Value("PRIVATE_NEW_WORKSPACE".into()),
    );
    let mut diagnostics = Diagnostics::default();
    assert!(
        resource
            .plan_update(
                &mut diagnostics,
                prior,
                changed.clone(),
                changed,
                Value::Null,
                Value::Null
            )
            .await
            .is_none()
    );
    let text = format!("{diagnostics:?}");
    assert!(text.contains("sandbox/reviewer"), "{text}");
    assert!(text.contains("changed fields: workspace"), "{text}");
    assert!(!text.contains("PRIVATE_"), "{text}");
}

#[tokio::test]
async fn removing_credential_reference_plans_unauthenticated_replacement() {
    let resource = ResourceAdapter::new(
        support::definition(
            "provider",
            &["credential_env", "credential_source"],
            &["credential_env"],
        ),
        Arc::new(Fixture(Ok(None))),
    );
    let prior = state(Row::from([
        ("id".into(), "registration".into()),
        ("credential_env".into(), "API_KEY".into()),
        ("credential_source".into(), String::new()),
    ]));
    let mut config = prior.clone();
    config.insert("credential_env".into(), Value::Null);
    let mut diagnostics = Diagnostics::default();
    let (planned, _, replacements) = resource
        .plan_update(
            &mut diagnostics,
            prior.clone(),
            prior,
            config,
            Value::Null,
            Value::Null,
        )
        .await
        .unwrap();
    assert!(diagnostics.errors.is_empty());
    assert_eq!(planned["credential_env"], Value::Value(String::new()));
    assert_eq!(replacements.len(), 1);
}

#[tokio::test]
async fn external_ollama_observation_names_the_authored_upstream_without_url_credentials() {
    for upstream in [
        "http://127.0.0.1:11434/v1",
        "http://[::1]:11434/v1",
        "http://user:PRIVATE_URL@127.0.0.1:11434/v1",
    ] {
        let resource = ResourceAdapter::new(
            support::definition(
                "ollama_external_model",
                &["name", "owner", "generation", "upstream"],
                &[],
            ),
            Arc::new(Fixture(Err(ObservationError::Incomplete))),
        );
        let mut values = row();
        values.insert(
            "name".into(),
            "nc-1234567890abcdef-ollama-proxy-local".into(),
        );
        values.insert("upstream".into(), upstream.into());
        let mut diagnostics = Diagnostics::default();
        resource
            .read(&mut diagnostics, state(values), Value::Null, Value::Null)
            .await;
        let text = format!("{diagnostics:?}");
        assert!(text.contains("services.local.upstream"), "{text}");
        assert!(text.contains("observation is incomplete"), "{text}");
        if !upstream.contains("PRIVATE_") {
            assert!(text.contains(upstream), "{text}");
        }
        assert!(!text.contains("PRIVATE_"), "{text}");
    }
}
