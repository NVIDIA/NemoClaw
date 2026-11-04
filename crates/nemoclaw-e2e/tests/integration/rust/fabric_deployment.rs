// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fabric runtime failures that only the SDK's lifecycle reports: a lost
//! runtime declaration in saved state, and a rejected start whose message
//! stays in the deployment's private diagnostics. The HCL integration
//! scenarios own reconciliation, restart, and replacement of agents.
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::{fs, path::PathBuf};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn missing_runtime_declaration_stops_planning_without_recreation() {
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
    let path = directory.path().join("terraform.tfstate");
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for resource in state["resources"].as_array_mut().unwrap() {
        let field = match resource["type"].as_str().unwrap() {
            "openshell_inference" => "api",
            "openshell_sandbox" => "launch_json",
            _ => continue,
        };
        resource["instances"][0]["attributes"]
            .as_object_mut()
            .unwrap()
            .remove(field);
    }
    fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    let before = fs::read(&path).unwrap();
    fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .values_mut()
        .next()
        .unwrap()
        .metadata
        .as_mut()
        .unwrap()
        .labels
        .remove("nemoclaw.nvidia.com/agent-runtime");
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert!(deployment.export(&cancel).await.is_err());
    assert_eq!(fixture.state.lock().unwrap().effects, 4);
    assert_eq!(fs::read(&path).unwrap(), before);
}

/// A first apply whose agent start Fabric rejects reports it without Fabric's
/// message, which stays in the deployment's private diagnostics. A corrected
/// document is accepted: the failed start may have left a runtime running, so
/// the agent starts in a new sandbox.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated gateway fixture"]
async fn a_rejected_start_is_reported_safely_and_a_corrected_document_replaces_the_sandbox() {
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
    fixture.state.lock().unwrap().configuration_error = Some(serde_json::json!({
        "error": {"stage":"start", "code":"start_failed", "message":"native-secret-must-not-escape"}
    }));
    let error = deployment
        .apply(&document, &cancel)
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("start_failed"), "{error}");
    assert!(error.contains("sandbox/assistant"), "{error}");
    assert!(error.contains("agent runtime is unknown"), "{error}");
    assert!(!error.contains("native-secret"), "{error}");
    let saved = std::path::absolute(directory.path())
        .unwrap()
        .join("diagnostics")
        .join("fabric-assistant.json");
    assert!(
        error.contains(&format!("Fabric's message is in {}", saved.display())),
        "{error}"
    );
    let message: serde_json::Value = serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
    assert_eq!(message["message"], "native-secret-must-not-escape");
    let current = || {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.sandboxes.len(), 1);
        state
            .sandboxes
            .values()
            .next()
            .unwrap()
            .metadata
            .as_ref()
            .unwrap()
            .id
            .clone()
    };
    let failed = current();
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .fabric_uncertain
            .contains(&failed)
    );

    document
        .spec
        .sandboxes
        .get_mut("assistant")
        .unwrap()
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "corrected-model".into();
    fixture.state.lock().unwrap().configuration_error = None;
    deployment
        .apply(&document, &cancel)
        .await
        .expect("a corrected document replaces the sandbox");
    let recovered = current();
    assert_ne!(recovered, failed);
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .fabric_configurations
            .contains_key(&recovered)
    );
    deployment.destroy(&cancel).await.unwrap();
}
