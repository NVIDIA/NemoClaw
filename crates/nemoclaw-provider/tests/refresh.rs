// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use async_trait::async_trait;
use nemoclaw_provider::{Backend, Definition, Mutation, ResourceAdapter, Row, State};
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
async fn failed_and_partial_observations_retain_protocol_state() {
    let mut partial = row();
    partial.remove("id");
    let mut foreign = row();
    foreign.insert("owner".into(), "someone-else".into());
    for observation in [
        Err(ObservationError::Transport),
        Ok(Some(partial)),
        Ok(Some(foreign)),
    ] {
        let resource = ResourceAdapter::new(
            Definition::new("workspace", &["name", "owner", "generation"], &[]),
            Arc::new(Fixture(observation)),
        );
        let mut diagnostics = Diagnostics::default();
        let original = state(row());
        let result = resource
            .read(&mut diagnostics, original.clone(), Value::Null, Value::Null)
            .await;
        assert!(!diagnostics.errors.is_empty());
        assert_eq!(result.unwrap().0, original);
    }
}

#[tokio::test]
async fn confirmed_absence_has_no_error_and_returns_null_state() {
    let resource = ResourceAdapter::new(
        Definition::new("workspace", &["name", "owner", "generation"], &[]),
        Arc::new(Fixture(Ok(None))),
    );
    let mut diagnostics = Diagnostics::default();
    assert!(
        resource
            .read(&mut diagnostics, state(row()), Value::Null, Value::Null)
            .await
            .is_none()
    );
    assert!(diagnostics.errors.is_empty());
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
        Definition::new("workspace", &["name", "owner", "generation"], &[]),
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
        Definition::new("inference_service", &["spec", "running"], &["running"]),
        Arc::new(ExitedAfterStart),
    );
    let mut diagnostics = Diagnostics::default();
    let configured = State::from([
        ("spec".into(), Value::Value("pinned-spec".into())),
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
