// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Cluster resource identities remain bound to the authored or saved spec.

use async_trait::async_trait;
use nemoclaw_provider::{Backend, Mutation, ResourceAdapter, Row, State};
use nemoclaw_sdk::{Error, ObservationError, compile, config::Document};
use std::sync::{Arc, Mutex};
use tf_provider::{Diagnostics, Resource, value::Value};

#[derive(Default)]
struct Fixture(Mutex<Vec<Row>>, Mutex<Option<(String, String)>>);

#[async_trait]
impl Backend for Fixture {
    async fn plan(&self, _: &str, desired: &Row, _: Option<&Row>) -> Result<(), Error> {
        self.0.lock().unwrap().push(desired.clone());
        Ok(())
    }
    async fn read(&self, _: &str, prior: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
        self.0.lock().unwrap().push(prior.clone());
        let mut observed = prior.clone();
        observed.remove("owner");
        observed.remove("generation");
        if let Some((field, value)) = self.1.lock().unwrap().clone() {
            observed.insert(field, value);
        }
        Ok(Some(observed))
    }
    async fn ensure(&self, _: &str, desired: &Row) -> Mutation {
        self.0.lock().unwrap().push(desired.clone());
        let mut observed = desired.clone();
        observed.remove("owner");
        observed.remove("generation");
        observed.insert("id".into(), "cluster-binding".into());
        observed.insert("running".into(), "true".into());
        Mutation::complete(observed)
    }
    async fn remove(&self, _: &str, prior: &Row, _: bool) -> Result<(), ObservationError> {
        self.0.lock().unwrap().push(prior.clone());
        Ok(())
    }
}

fn targets() -> Vec<(String, State, serde_json::Value)> {
    [
        include_bytes!("../../../crates/test-support/cluster-models/vllm.yaml").as_slice(),
        include_bytes!("../../../crates/test-support/cluster-models/ollama.yaml").as_slice(),
    ]
    .into_iter()
    .flat_map(|source| {
        let document = Document::parse(source).unwrap();
        let generations = [
            "kubernetes_storage",
            "kubernetes_gateway",
            "inference_service",
            "ollama_service",
        ]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
        compile::runtime_targets(&document, &generations)
            .unwrap()
            .into_iter()
            .filter(|target| {
                matches!(
                    target.kind.as_str(),
                    "kubernetes_service" | "kubernetes_service_storage"
                )
            })
            .map(|target| {
                // Formatting is intentional: exposing identity must not rewrite saved spec bytes.
                let spec: serde_json::Value = serde_json::from_str(&target.values["spec"]).unwrap();
                let state = State::from([
                    (
                        "spec".into(),
                        Value::Value(serde_json::to_string_pretty(&spec).unwrap()),
                    ),
                    ("id".into(), Value::Null),
                    ("running".into(), Value::Null),
                    ("owner".into(), Value::Null),
                    ("generation".into(), Value::Null),
                ]);
                (target.kind, state, spec)
            })
            .collect::<Vec<_>>()
    })
    .collect()
}

fn adapter(kind: &str, fixture: &Arc<Fixture>) -> ResourceAdapter {
    ResourceAdapter::new(
        nemoclaw_provider::resource_definition(kind).unwrap(),
        fixture.clone(),
    )
}

#[tokio::test]
async fn omitted_cluster_identity_is_derived_from_spec_and_preserves_legacy_bindings() {
    for (kind, config, spec) in targets() {
        let fixture = Arc::new(Fixture::default());
        let resource = adapter(&kind, &fixture);
        let mut diagnostics = Diagnostics::default();
        let planned = resource
            .plan_create(
                &mut diagnostics,
                config.clone(),
                config.clone(),
                Value::Null,
            )
            .await
            .unwrap()
            .0;
        for name in ["owner", "generation"] {
            assert_eq!(
                planned.get(name),
                Some(&Value::Value(spec[name].as_str().unwrap().into())),
                "{kind}.{name}"
            );
        }
        let applied = resource
            .create(
                &mut diagnostics,
                planned,
                config.clone(),
                Value::Null,
                Value::Null,
            )
            .await
            .unwrap()
            .0;
        assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
        assert_eq!(applied["spec"], config["spec"]);
        let mut legacy = applied.clone();
        legacy.remove("owner");
        legacy.remove("generation");
        let refreshed = resource
            .read(&mut diagnostics, legacy.clone(), Value::Null, Value::Null)
            .await
            .unwrap()
            .0;
        assert_eq!(
            refreshed, applied,
            "refresh must retain the recorded identity"
        );
        let (updated, _, replacements) = resource
            .plan_update(
                &mut diagnostics,
                legacy,
                refreshed,
                config.clone(),
                Value::Null,
                Value::Null,
            )
            .await
            .unwrap();
        assert!(
            replacements.is_empty(),
            "identity projection must not require replacement"
        );
        assert_eq!(updated, applied);
        assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
    }
}

#[tokio::test]
async fn conflicting_cluster_identity_is_rejected_before_backend_calls() {
    for (kind, config, _) in targets() {
        for field in ["owner", "generation"] {
            for replacement in ["", "foreign-identity"] {
                let fixture = Arc::new(Fixture::default());
                let resource = adapter(&kind, &fixture);
                let mut changed = config.clone();
                changed.insert(field.into(), Value::Value(replacement.into()));
                let mut diagnostics = Diagnostics::default();
                assert!(
                    resource
                        .validate(&mut diagnostics, changed.clone())
                        .await
                        .is_none(),
                    "{kind}.{field}"
                );
                assert!(!diagnostics.errors.is_empty());
                let mut diagnostics = Diagnostics::default();
                assert!(
                    resource
                        .plan_create(
                            &mut diagnostics,
                            changed.clone(),
                            changed.clone(),
                            Value::Null
                        )
                        .await
                        .is_none()
                );
                assert!(!diagnostics.errors.is_empty());
                let mut diagnostics = Diagnostics::default();
                assert!(
                    resource
                        .create(
                            &mut diagnostics,
                            changed.clone(),
                            changed.clone(),
                            Value::Null,
                            Value::Null
                        )
                        .await
                        .is_none()
                );
                changed.insert("id".into(), Value::Value("cluster-binding".into()));
                changed.insert("running".into(), Value::Value("true".into()));
                let mut diagnostics = Diagnostics::default();
                let retained = resource
                    .read(&mut diagnostics, changed.clone(), Value::Null, Value::Null)
                    .await
                    .unwrap()
                    .0;
                assert_eq!(retained, changed);
                assert!(!diagnostics.errors.is_empty());
                let mut diagnostics = Diagnostics::default();
                assert!(
                    resource
                        .destroy(&mut diagnostics, changed, Value::Null, Value::Null)
                        .await
                        .is_none()
                );
                assert!(
                    fixture.0.lock().unwrap().is_empty(),
                    "invalid identity reached the backend"
                );
            }
        }
    }
}

#[tokio::test]
async fn cluster_identity_waits_for_an_unknown_spec_without_contacting_the_backend() {
    for (kind, mut config, _) in targets() {
        config.insert("spec".into(), Value::Unknown);
        let fixture = Arc::new(Fixture::default());
        let resource = adapter(&kind, &fixture);
        let mut diagnostics = Diagnostics::default();
        let planned = resource
            .plan_create(&mut diagnostics, config.clone(), config, Value::Null)
            .await
            .unwrap()
            .0;
        for name in ["owner", "generation"] {
            assert_eq!(planned.get(name), Some(&Value::Unknown), "{kind}.{name}");
        }
        assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
        assert!(fixture.0.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn unknown_updated_spec_retains_cluster_identity_without_replacement() {
    for (kind, config, spec) in targets()
        .into_iter()
        .filter(|(kind, _, _)| kind == "kubernetes_service")
    {
        let fixture = Arc::new(Fixture::default());
        let resource = adapter(&kind, &fixture);
        let mut prior = config.clone();
        prior.insert("id".into(), Value::Value("cluster-binding".into()));
        prior.insert("running".into(), Value::Value("true".into()));
        for field in ["owner", "generation"] {
            prior.insert(
                field.into(),
                Value::Value(spec[field].as_str().unwrap().into()),
            );
        }
        let mut config = config;
        config.insert("spec".into(), Value::Unknown);
        let mut proposed = config.clone();
        proposed.insert("id".into(), Value::Unknown);
        proposed.insert("running".into(), Value::Unknown);
        proposed.insert("owner".into(), Value::Unknown);
        proposed.insert("generation".into(), Value::Unknown);
        let mut diagnostics = Diagnostics::default();
        let (planned, _, replacements) = resource
            .plan_update(
                &mut diagnostics,
                prior.clone(),
                proposed,
                config,
                Value::Null,
                Value::Null,
            )
            .await
            .expect("unknown sources must not discard an established identity");
        assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
        assert!(replacements.is_empty());
        for field in ["id", "owner", "generation"] {
            assert_eq!(planned[field], prior[field], "{kind}.{field}");
        }
        assert!(fixture.0.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn contradictory_observed_cluster_identity_retains_saved_state() {
    for (kind, config, spec) in targets() {
        for field in ["owner", "generation"] {
            let fixture = Arc::new(Fixture::default());
            *fixture.1.lock().unwrap() = Some((field.into(), "foreign-identity".into()));
            let resource = adapter(&kind, &fixture);
            let mut prior = config.clone();
            prior.insert("id".into(), Value::Value("cluster-binding".into()));
            prior.insert("running".into(), Value::Value("true".into()));
            for field in ["owner", "generation"] {
                prior.insert(
                    field.into(),
                    Value::Value(spec[field].as_str().unwrap().into()),
                );
            }
            let mut diagnostics = Diagnostics::default();
            let observed = resource
                .read(&mut diagnostics, prior.clone(), Value::Null, Value::Null)
                .await
                .unwrap()
                .0;
            assert_eq!(observed, prior);
            assert!(!diagnostics.errors.is_empty(), "{kind}.{field}");
        }
    }
}
