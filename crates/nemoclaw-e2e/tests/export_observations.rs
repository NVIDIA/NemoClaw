// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, Error, config::Document};
use std::{fs, path::PathBuf};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn export_refreshes_through_opentofu_without_applying_or_losing_bindings() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let intent = fs::read(directory.path().join("intent.json")).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    let gateway_reads = fixture.state.lock().unwrap().gateway_reads;
    fixture.state.lock().unwrap().exec_calls.clear();
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    let error = deployment.export(&cancel).await.unwrap_err();
    assert!(
        matches!(&error, Error::Execution { operation, .. } if operation == "plan"),
        "{error}"
    );
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        state
    );
    assert_eq!(
        fs::read(directory.path().join("intent.json")).unwrap(),
        intent
    );
    fixture.state.lock().unwrap().fail_read = None;
    // Export observes managed resources, without running deployment readiness data sources.
    fixture.state.lock().unwrap().driver = Some("podman".into());
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        state
    );
    assert_eq!(
        fs::read(directory.path().join("intent.json")).unwrap(),
        intent
    );
    {
        let observed = fixture.state.lock().unwrap();
        assert_eq!(observed.effects, effects);
        assert_eq!(observed.gateway_reads, gateway_reads);
        assert!(
            observed.exec_calls.iter().all(|command| {
                !command
                    .iter()
                    .any(|argument| matches!(argument.as_str(), "health" | "probe"))
            }),
            "export must not run runtime health or generation probes"
        );
    }
    deployment.destroy(&cancel).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn export_uses_provider_observations_without_resolving_inference_credentials() {
    struct Values;
    impl nemoclaw_sdk::openshell::Secrets for Values {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            Ok("fixture-value".into())
        }
    }
    struct Unavailable;
    impl nemoclaw_sdk::openshell::Secrets for Unavailable {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            Err(nemoclaw_sdk::ObservationError::Authentication)
        }
    }
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    document.spec.inference_providers[0].endpoint = "https://models.example/v1".into();
    document.spec.inference_providers[0].credential = Some(nemoclaw_sdk::config::Credential {
        env: "EXPORT_INFERENCE_REFERENCE".into(),
    });
    let cancel = CancellationToken::new();
    Deployment::new(directory.path(), &bundle)
        .with_secrets(std::sync::Arc::new(Values))
        .apply(&document, &cancel)
        .await
        .unwrap();
    let deployment =
        Deployment::new(directory.path(), &bundle).with_secrets(std::sync::Arc::new(Unavailable));
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    // The plan's refreshed observations, rather than the saved state snapshot,
    // must supply references that export is allowed to project back into YAML.
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    for provider in fixture.state.lock().unwrap().providers.values_mut() {
        provider.metadata.as_mut().unwrap().labels.insert(
            nemoclaw_sdk::openshell::CREDENTIAL.into(),
            "CHANGED_EXPORT_REFERENCE".into(),
        );
    }
    document.spec.inference_providers[0]
        .credential
        .as_mut()
        .unwrap()
        .env = "CHANGED_EXPORT_REFERENCE".into();
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        state
    );
    deployment.destroy(&cancel).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn export_rejects_observed_pi_model_drift_without_reconfiguring_it() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind =
        nemoclaw_sdk::config::HarnessKind::Pi;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    for model in fixture.state.lock().unwrap().pi_models.values_mut() {
        model["model"] = serde_json::json!("foreign-model");
    }
    assert!(deployment.export(&cancel).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        state
    );
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .pi_models
            .values()
            .all(|model| model["model"] == "foreign-model")
    );
    deployment.destroy(&cancel).await.unwrap();
}
