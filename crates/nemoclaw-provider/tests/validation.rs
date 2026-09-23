// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_provider::{Backend, Definition, Mutation, ResourceAdapter, Row, State};
use nemoclaw_sdk::ObservationError;
use std::sync::Arc;
mod support;
use serde_json::{Value, json};
use support::specification;
use tf_provider::{AttributePath, Diagnostics, Resource};

struct Offline;
#[async_trait::async_trait]
impl Backend for Offline {
    async fn plan(&self, _: &str, _: &Row, _: Option<&Row>) -> Result<(), nemoclaw_sdk::Error> {
        panic!("offline or unknown configuration observed a host")
    }
    async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
        panic!("validation observed a host")
    }
    async fn ensure(&self, _: &str, _: &Row) -> Mutation {
        panic!("validation mutated a host")
    }
    async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
        panic!("validation mutated a host")
    }
}
fn resource() -> ResourceAdapter {
    ResourceAdapter::new(
        Definition::new(
            "inference_service",
            &["spec", "image_pull_policy"],
            &["image_pull_policy"],
        ),
        Arc::new(Offline),
    )
}

struct IncompatibleHost(std::sync::atomic::AtomicUsize);
#[async_trait::async_trait]
impl Backend for IncompatibleHost {
    async fn plan(&self, _: &str, _: &Row, prior: Option<&Row>) -> Result<(), nemoclaw_sdk::Error> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(prior) = prior {
            assert_eq!(prior["id"], "retained-id");
        }
        Err(
            ObservationError::Hardware(nemoclaw_sdk::hardware::HardwareDiagnostic::Minimum {
                field: "hardware.minDriverMajor",
                required: 580,
                observed: 570,
            })
            .into(),
        )
    }
    async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
        panic!("adapter must delegate observation to plan")
    }
    async fn ensure(&self, _: &str, _: &Row) -> Mutation {
        panic!("plan mutated a host")
    }
    async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
        panic!("plan mutated a host")
    }
}

#[tokio::test]
async fn planning_blocks_incompatible_creates_and_updates_but_defers_unknown_configuration() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tf_provider::value::Value as TofuValue;
    let backend = Arc::new(IncompatibleHost(AtomicUsize::new(0)));
    let resource = ResourceAdapter::new(
        Definition::new("inference_service", &["spec"], &[]),
        backend.clone(),
    );
    let config: State = serde_json::from_value(
        json!({"spec":specification("inference_service").to_string(), "id":null}),
    )
    .unwrap();
    let mut diagnostics = Diagnostics::default();
    let result = resource
        .plan_create(
            &mut diagnostics,
            config.clone(),
            config.clone(),
            TofuValue::Null,
        )
        .await;
    assert!(result.is_none());
    assert_eq!(diagnostics.errors[0].attribute, AttributePath::new("spec"));
    assert!(diagnostics.errors[0].detail.contains("observed 570"));
    let mut prior = config.clone();
    prior.insert("id".into(), TofuValue::Value("retained-id".into()));
    let mut diagnostics = Diagnostics::default();
    assert!(
        resource
            .plan_update(
                &mut diagnostics,
                prior.clone(),
                prior,
                config.clone(),
                TofuValue::Null,
                TofuValue::Null
            )
            .await
            .is_none()
    );
    assert_eq!(backend.0.load(Ordering::SeqCst), 2);
    let mut unknown = config;
    unknown.insert("spec".into(), TofuValue::Unknown);
    let mut diagnostics = Diagnostics::default();
    resource
        .validate(&mut diagnostics, unknown.clone())
        .await
        .unwrap();
    let (planned, _) = resource
        .plan_create(&mut diagnostics, unknown.clone(), unknown, TofuValue::Null)
        .await
        .unwrap();
    assert_eq!(planned["spec"], TofuValue::Unknown);
    assert!(diagnostics.errors.is_empty());
    assert_eq!(backend.0.load(Ordering::SeqCst), 2);
    resource
        .plan_destroy(&mut diagnostics, planned, TofuValue::Null, TofuValue::Null)
        .await
        .unwrap();
    assert_eq!(
        backend.0.load(Ordering::SeqCst),
        2,
        "destroy must not require available capacity"
    );
}

#[tokio::test]
async fn offline_validation_rejects_invalid_hardware_at_the_spec_attribute() {
    let resource = resource();
    let mut diagnostics = Diagnostics::default();
    let mut spec = specification("inference_service");
    let mut configuration: Value =
        serde_json::from_str(spec["process"]["configuration"].as_str().unwrap()).unwrap();
    configuration["hardware"] = json!({"profile":"h100"});
    spec["process"]["configuration"] = json!(configuration.to_string());
    let state = json!({"spec":spec.to_string(), "id":null, "image_pull_policy":null});
    resource
        .validate(
            &mut diagnostics,
            serde_json::from_value::<State>(state).unwrap(),
        )
        .await;
    assert_eq!(diagnostics.errors.len(), 1, "{diagnostics:?}");
    assert_eq!(diagnostics.errors[0].attribute, AttributePath::new("spec"));
    assert!(
        diagnostics.errors[0].detail.contains("architecture"),
        "{diagnostics:?}"
    );
}

#[tokio::test]
async fn offline_validation_accepts_valid_hardware_without_configuring_or_observing_a_host() {
    let resource = resource();
    let mut diagnostics = Diagnostics::default();
    let state = json!({"spec":specification("inference_service").to_string(), "id":null, "image_pull_policy":null});
    resource
        .validate(
            &mut diagnostics,
            serde_json::from_value::<State>(state).unwrap(),
        )
        .await;
    assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
}

#[tokio::test]
async fn unknown_optional_configuration_is_preserved_and_malformed_specs_do_not_leak_input() {
    use tf_provider::value::Value as TofuValue;
    let resource = resource();
    let mut config: State = serde_json::from_value(
        json!({"spec":specification("inference_service").to_string(), "id":null}),
    )
    .unwrap();
    config.insert("image_pull_policy".into(), TofuValue::Unknown);
    let mut diagnostics = Diagnostics::default();
    let (planned, _) = resource
        .plan_create(
            &mut diagnostics,
            config.clone(),
            config.clone(),
            TofuValue::Null,
        )
        .await
        .unwrap();
    assert_eq!(planned["image_pull_policy"], TofuValue::Unknown);
    assert!(diagnostics.errors.is_empty());
    for spec in [TofuValue::Null, TofuValue::Value("PRIVATE_SENTINEL".into())] {
        config.insert("spec".into(), spec);
        let mut diagnostics = Diagnostics::default();
        assert!(
            resource
                .validate(&mut diagnostics, config.clone())
                .await
                .is_none()
        );
        assert_eq!(diagnostics.errors[0].attribute, AttributePath::new("spec"));
        assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
    }
}
