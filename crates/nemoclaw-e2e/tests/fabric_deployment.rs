// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document};
use std::{fs, path::PathBuf};

macro_rules! harness_test {
    ($name:ident, $harness:literal) => {
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        #[ignore = "requires explicit verified NEMOCLAW_TEST_BUNDLE"]
        async fn $name() {
            harness_preserves_conversations_and_rejects_runtime_drift($harness).await;
        }
    };
}

harness_test!(harness_deepagents, "deepagents");
harness_test!(harness_hermes, "hermes");
harness_test!(harness_openclaw, "openclaw");
harness_test!(harness_claude, "claude");
harness_test!(harness_codex, "codex");
harness_test!(harness_mini_swe_agent, "mini-swe-agent");
harness_test!(harness_nooa, "nooa");
harness_test!(harness_nooa_bench, "nooa-bench");
harness_test!(harness_remote_agent, "remote-agent");
harness_test!(harness_pi, "pi");

async fn harness_preserves_conversations_and_rejects_runtime_drift(harness: &str) {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    document.spec.sandboxes[0].harness.as_mut().unwrap().kind = harness.into();
    if harness == "pi" {
        let pi = Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/fabric-pi.yaml").as_bytes(),
        )
        .unwrap();
        document.spec.sandboxes[0]
            .agent
            .inference
            .as_mut()
            .unwrap()
            .routes[0]
            .overrides = pi.spec.sandboxes[0]
            .agent
            .inference
            .as_ref()
            .unwrap()
            .routes[0]
            .overrides
            .clone();
    }
    if harness == "claude" {
        document.spec.inference_providers[0].provider = "anthropic".into();
    }
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    fixture.state.lock().unwrap().inference_exit = 1;
    deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        !fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .flatten()
            .any(|arg| arg.contains("inference-probe")
                || arg.contains("pi-probe")
                || arg == "probe"
                || arg == "--message")
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
    nemoclaw_e2e::assert_same_deployment_state(
        &fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        &state,
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
    if harness == "pi" {
        let mut changed_model = document.clone();
        changed_model.spec.sandboxes[0]
            .agent
            .inference
            .as_mut()
            .unwrap()
            .routes[0]
            .overrides
            .model = "another-custom-model".into();
        let planned = deployment.plan(&changed_model, &cancel).await.unwrap();
        assert!(planned.changes.iter().any(|change| change.resource
            == format!("fabric_runtime.{}", document.spec.sandboxes[0].name)));
        let applied = deployment.apply(&changed_model, &cancel).await.unwrap();
        assert!(applied.changes.iter().all(|change| {
            !change
                .actions
                .iter()
                .any(|action| action == "delete" || action == "create")
        }));
        assert_eq!(deployment.export(&cancel).await.unwrap(), changed_model);
        let calls = fixture.state.lock().unwrap().exec_calls.clone();
        let configured = calls
            .iter()
            .rev()
            .find(|command| command.get(2).is_some_and(|arg| arg == "configure"))
            .unwrap();
        let model: serde_json::Value = serde_json::from_str(&configured[5]).unwrap();
        assert_eq!(model["model"], "another-custom-model");
        assert!(
            calls
                .iter()
                .any(|command| command.get(2).is_some_and(|arg| arg == "prepare"))
        );
        deployment.apply(&document, &cancel).await.unwrap();
    }
    let effects = fixture.state.lock().unwrap().effects;
    let state = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let mut changed = document.clone();
    changed.spec.sandboxes[0].harness.as_mut().unwrap().kind = if harness == "deepagents" {
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
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
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
