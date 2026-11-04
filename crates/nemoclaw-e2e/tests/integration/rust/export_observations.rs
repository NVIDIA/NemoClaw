// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Export through the bundle's OpenTofu: it observes managed resources
//! without the deployment's readiness checks, and needs no credential, as
//! preview and teardown don't either. The SDK's unit tests own how
//! observations become an exported document.
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::{fs, path::PathBuf};

/// Export observes managed resources without the deployment's readiness data
/// sources, so a gateway that now reports another compute driver doesn't
/// block it; it runs no runtime probe and changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn export_skips_gateway_readiness_and_changes_nothing() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let intent = fs::read(directory.path().join("intent.json")).unwrap();
    let (effects, gateway_reads) = {
        let mut observed = fixture.state.lock().unwrap();
        observed.exec_calls.clear();
        observed.driver = Some("podman".into());
        (observed.effects, observed.gateway_reads)
    };
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

/// A credentialed deployment keeps its secret out of state. Once the
/// credential is unavailable, export still returns the document, and preview
/// and teardown still work; export after destroy is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn a_credentialed_deployment_exports_and_tears_down_without_its_secret() {
    use std::sync::Arc;

    const REFERENCE: &str = "INFERENCE_LIFECYCLE_KEY";
    const SECRET: &str = "fixture-inference-secret";
    struct Values;
    impl nemoclaw_sdk::Secrets for Values {
        fn resolve(&self, reference: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            assert_eq!(reference, REFERENCE);
            Ok(SECRET.into())
        }
    }
    struct Unavailable;
    impl nemoclaw_sdk::Secrets for Unavailable {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            Err(nemoclaw_sdk::ObservationError::Authentication)
        }
    }
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let provider = document.spec.inference_providers.get_mut("local").unwrap();
    provider.endpoint = "https://unreachable.invalid/v1".into();
    provider.credential = Some(nemoclaw_sdk::config::SecretRef {
        env: REFERENCE.into(),
    });
    let cancel = CancellationToken::new();
    // An inference probe would fail, so planning and applying show none ran.
    fixture.state.lock().unwrap().inference_exit = 1;
    Deployment::new(directory.path(), &bundle)
        .with_secrets(Arc::new(Values))
        .apply(&document, &cancel)
        .await
        .unwrap();
    let state_path = directory.path().join("terraform.tfstate");
    let state = fs::read(&state_path).unwrap();
    assert!(!String::from_utf8_lossy(&state).contains(SECRET));

    let unavailable =
        Deployment::new(directory.path(), &bundle).with_secrets(Arc::new(Unavailable));
    assert_eq!(unavailable.export(&cancel).await.unwrap(), document);
    let effects = fixture.state.lock().unwrap().effects;
    assert!(
        !unavailable
            .plan_destroy(&cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(fs::read(&state_path).unwrap(), state);
    assert_eq!(
        unavailable.destroy(&cancel).await.unwrap().outcome,
        nemoclaw_sdk::Outcome::Destroyed
    );
    let error = unavailable.export(&cancel).await.unwrap_err().to_string();
    assert!(
        error.contains("cannot export a destroyed deployment"),
        "{error}"
    );
    let observed = fixture.state.lock().unwrap();
    assert!(observed.providers.is_empty());
    assert!(observed.sandboxes.is_empty());
    assert!(observed.workspaces.is_empty());
}
