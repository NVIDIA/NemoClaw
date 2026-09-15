// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::{fs, path::PathBuf};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn every_fabric_harness_preserves_conversations_and_rejects_runtime_drift() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    for harness in [
        "deepagents",
        "hermes",
        "openclaw",
        "claude",
        "codex",
        "mini-swe-agent",
        "nooa",
        "nooa-bench",
        "remote-agent",
        "pi",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let fixture = Fixture::start().await;
        let mut document = Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
        )
        .unwrap();
        document.spec.gateway.endpoint = fixture.endpoint.clone();
        document.spec.sandboxes[0].agents[0].agent_type = "fabric".into();
        document.spec.sandboxes[0].agents[0].harness = harness.into();
        if harness == "claude" {
            document.spec.inference_providers[0].provider = "anthropic".into();
        }
        let deployment = Deployment::new(directory.path(), &bundle);
        let cancel = CancellationToken::new();
        let applied = deployment.apply(&document, &cancel).await.unwrap();
        assert!(
            applied.agent_response.is_empty(),
            "apply must not inject a conversation into {harness}"
        );
        let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
        let effects = fixture.state.lock().unwrap().effects;
        assert_eq!(effects, 4);
        assert!(
            deployment
                .apply(&document, &cancel)
                .await
                .unwrap()
                .changes
                .is_empty()
        );
        assert_eq!(deployment.export(&cancel).await.unwrap(), document);
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
                .exec_calls
                .iter()
                .all(|command| !command
                    .iter()
                    .any(|arg| arg == "invoke" || arg == "--message"))
        );
        let mut changed = document.clone();
        changed.spec.sandboxes[0].agents[0].harness = if harness == "deepagents" {
            "hermes"
        } else {
            "deepagents"
        }
        .into();
        changed.spec.inference_providers[0].provider = "openai".into();
        assert!(
            deployment.apply(&changed, &cancel).await.is_err(),
            "{harness} replacement must be refused"
        );
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .values_mut()
            .next()
            .unwrap()
            .spec
            .as_mut()
            .unwrap()
            .environment
            .insert("OPENAI_API_KEY".into(), "changed".into());
        assert!(deployment.export(&cancel).await.is_err());
        assert!(deployment.plan(&document, &cancel).await.is_err());
        assert_eq!(fixture.state.lock().unwrap().effects, effects);
        assert_eq!(
            fs::read(directory.path().join("terraform.tfstate")).unwrap(),
            state
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
async fn missing_runtime_declaration_stops_planning_without_recreation() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    deployment.apply(&document, &cancel).await.unwrap();
    let path = directory.path().join("terraform.tfstate");
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for resource in state["resources"].as_array_mut().unwrap() {
        let field = match resource["type"].as_str().unwrap() {
            "nemoclaw_provider" => "provider_type",
            "nemoclaw_sandbox" => "agent_runtime",
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
