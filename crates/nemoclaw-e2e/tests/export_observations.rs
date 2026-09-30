// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Deployment planning requires image discovery, whose engine transports are Unix-only.
#![cfg(unix)]

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
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
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
    impl nemoclaw_sdk::Secrets for Values {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            Ok("fixture-value".into())
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
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
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
            nemoclaw_provider::openshell::CREDENTIAL.into(),
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
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind = "nvidia.fabric.pi".parse().unwrap();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    for model in fixture
        .state
        .lock()
        .unwrap()
        .fabric_configurations
        .values_mut()
    {
        model["models"]["default"]["model"] = serde_json::json!("foreign-model");
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
            .fabric_configurations
            .values()
            .all(|model| model["models"]["default"]["model"] == "foreign-model")
    );
    deployment.destroy(&cancel).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn mixed_search_export_preserves_scopes_shared_registrations_and_state_on_drift() {
    use nemoclaw_sdk::config::SearchProvider;
    use std::{process::Command, sync::Arc};

    struct Values;
    impl nemoclaw_sdk::Secrets for Values {
        fn resolve(&self, reference: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            assert!(["EXPORT_TAVILY_KEY", "EXPORT_BRAVE_KEY"].contains(&reference));
            Ok("fixture-search-credential".into())
        }
    }
    struct Unavailable;
    impl nemoclaw_sdk::Secrets for Unavailable {
        fn resolve(&self, _: &str) -> Result<String, nemoclaw_sdk::ObservationError> {
            panic!("export and destroy must not resolve search credentials")
        }
    }
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document =
        Document::parse(include_bytes!("../../../examples/fabric-openclaw.yaml").as_slice())
            .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    document.spec.inference_providers[0].endpoint = "https://127.0.0.1:9/v1".into();
    document.spec.integrations = serde_json::from_value(serde_json::json!({
        "shared-search":{"kind":"webSearch", "provider":"tavily", "credential":{"env":"EXPORT_TAVILY_KEY"}},
        "unused-search":{"kind":"webSearch", "provider":"brave", "credential":{"env":"UNUSED_EXPORT_KEY"}}
    })).unwrap();
    document.spec.sandboxes[0].agent.integration_refs = vec!["shared-search".into()];
    let mut hermes = document.spec.sandboxes[0].clone();
    hermes.name = "hermes".into();
    hermes.harness.as_mut().unwrap().kind = "nvidia.fabric.hermes".parse().unwrap();
    hermes.integrations = serde_json::from_value(serde_json::json!({
        "sandbox-search":{"kind":"webSearch", "provider":"brave", "credential":{"env":"EXPORT_BRAVE_KEY"}}
    })).unwrap();
    hermes.agent.integration_refs = vec!["sandbox-search".into()];
    let mut pi = hermes.clone();
    pi.name = "pi".into();
    pi.harness.as_mut().unwrap().kind = "nvidia.fabric.pi".parse().unwrap();
    pi.agent.integration_refs.clear();
    pi.agent.integrations = std::mem::take(&mut pi.integrations);
    document.spec.sandboxes.extend([hermes, pi]);
    let deployment = Deployment::new(directory.path(), &bundle).with_secrets(Arc::new(Values));
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        deployment
            .plan(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    let (providers, sandboxes, effects) = {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            state.providers.len(),
            6,
            "one inference and one search registration per sandbox image and adapter"
        );
        (
            state.providers.clone(),
            state.sandboxes.clone(),
            state.effects,
        )
    };
    let state_path = directory.path().join("terraform.tfstate");
    let intent_path = directory.path().join("intent.json");
    let before_state = fs::read(&state_path).unwrap();
    let before_intent = fs::read(&intent_path).unwrap();
    let observe = Deployment::new(directory.path(), &bundle).with_secrets(Arc::new(Unavailable));
    assert_eq!(observe.export(&cancel).await.unwrap(), document);
    let output = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["export", "--state-dir"])
    .arg(directory.path())
    .arg("--bundle")
    .arg(&bundle)
    .env_remove("EXPORT_TAVILY_KEY")
    .env_remove("EXPORT_BRAVE_KEY")
    .output()
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-search-credential"));
    let exported = Document::parse(output.stdout.as_slice()).unwrap();
    assert_eq!(exported, document);
    assert_eq!(fs::read(&state_path).unwrap(), before_state);
    assert_eq!(fs::read(&intent_path).unwrap(), before_intent);
    for (provider, reference) in [
        (SearchProvider::Tavily, "EXPORT_TAVILY_KEY"),
        (SearchProvider::Brave, "EXPORT_BRAVE_KEY"),
    ] {
        let key = format!(
            "{}/{}",
            document.workspace(),
            fixture
                .state
                .lock()
                .unwrap()
                .providers
                .values()
                .find(|p| p
                    .metadata
                    .as_ref()
                    .unwrap()
                    .labels
                    .get(nemoclaw_provider::openshell::CREDENTIAL)
                    .map(String::as_str)
                    == Some(reference))
                .unwrap()
                .metadata
                .as_ref()
                .unwrap()
                .name
                .clone()
        );
        for field in ["credential", "type"] {
            {
                let mut state = fixture.state.lock().unwrap();
                let observed = state.providers.get_mut(&key).unwrap();
                if field == "credential" {
                    observed.metadata.as_mut().unwrap().labels.insert(
                        nemoclaw_provider::openshell::CREDENTIAL.into(),
                        "FOREIGN_SEARCH_KEY".into(),
                    );
                } else {
                    observed.r#type = "nemoclaw-foreign".into();
                }
            }
            assert!(
                observe.export(&cancel).await.is_err(),
                "{provider:?}/{field}"
            );
            assert_eq!(fs::read(&state_path).unwrap(), before_state);
            assert_eq!(fs::read(&intent_path).unwrap(), before_intent);
            assert_eq!(fixture.state.lock().unwrap().effects, effects);
            fixture
                .state
                .lock()
                .unwrap()
                .providers
                .insert(key.clone(), providers[&key].clone());
        }
    }
    assert_eq!(observe.export(&cancel).await.unwrap(), document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.effects, effects);
        assert_eq!(state.providers, providers);
        assert_eq!(state.sandboxes, sandboxes);
    }
    observe.destroy(&cancel).await.unwrap();
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty());
    assert!(state.providers.is_empty());
    assert!(state.profiles.is_empty());
}
