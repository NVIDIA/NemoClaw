// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_e2e::{openshell::Fixture, tofu::TofuWorkspace};
use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated gateway fixture"]
async fn standalone_sandbox_completion_rejects_unknown_health_and_retains_bindings() {
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").unwrap());
    let provider = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").unwrap());
    let directory = TofuWorkspace::new(tofu, provider);
    let root = directory.path();
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_slice(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let generations = ["workspace", "provider", "sandbox"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let mut graph = compile::compile(&document, &generations, "0.1.0").unwrap();
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = directory.command().args(args).output().unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output.stdout
    };
    fixture.state.lock().unwrap().health_report =
        Some(json!({"supported":true,"report":null,"reason_code":"fabric_health_timeout"}));
    run(
        &["plan", "-out=apply.plan", "-input=false", "-no-color"],
        true,
    );
    assert!(fixture.state.lock().unwrap().exec_calls.is_empty());
    run(
        &["apply", "-json", "-input=false", "-no-color", "apply.plan"],
        false,
    );
    let shown: Value = serde_json::from_slice(&run(&["show", "-json"], true)).unwrap();
    let observations = shown["values"]["root_module"]["resources"]
        .as_array()
        .unwrap();
    let health = observations
        .iter()
        .find(|row| row["address"] == "data.nemoclaw_sandbox_readiness.assistant")
        .unwrap();
    assert_eq!(health["values"]["ready"], false);
    let failed_health: nemoclaw_sdk::RuntimeHealth =
        serde_json::from_str(health["values"]["health_json"].as_str().unwrap()).unwrap();
    assert!(failed_health.supported);
    assert!(failed_health.report.is_none());
    assert_eq!(
        failed_health.reason_code.as_deref(),
        Some("fabric_health_failed")
    );
    assert!(!failed_health.allows_apply_completion());
    assert!(health["values"]["error_message"].is_null());
    let token = health["values"]["read_trigger"]
        .as_str()
        .unwrap()
        .to_owned();
    let effects = fixture.state.lock().unwrap().effects;
    let ids = fixture
        .state
        .lock()
        .unwrap()
        .sandboxes
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    fixture.state.lock().unwrap().exec_calls.clear();
    run(
        &["plan", "-out=apply.plan", "-input=false", "-no-color"],
        true,
    );
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .all(|cmd| !cmd.iter().any(|part| matches!(
                part.as_str(),
                "--active" | "--ready" | "--operational" | "invoke"
            )))
    );
    fixture.state.lock().unwrap().health_report = None;
    run(&["apply", "-input=false", "-no-color", "apply.plan"], true);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    assert_eq!(
        fixture
            .state
            .lock()
            .unwrap()
            .sandboxes
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        ids
    );
    assert!(
        fixture
            .state
            .lock()
            .unwrap()
            .exec_calls
            .iter()
            .any(|cmd| cmd.get(1).is_some_and(|part| part == "check")
                && cmd.iter().any(|part| part == "--ready"))
    );
    let after: Value = serde_json::from_slice(&run(&["show", "-json"], true)).unwrap();
    let observation = after["values"]["root_module"]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["address"] == "data.nemoclaw_sandbox_readiness.assistant")
        .unwrap();
    assert_ne!(observation["values"]["read_trigger"], token);
    assert_eq!(observation["values"]["ready"], true);
    // Recheck admission independently of previously successful configuration.
    // The gateway may reject a policy while the sandbox is still Starting.
    {
        let mut state = fixture.state.lock().unwrap();
        for sandbox in state.sandboxes.values_mut() {
            let status = sandbox.status.as_mut().unwrap();
            status.phase = openshell_core::proto::SandboxPhase::Starting as i32;
            status.configuration_admission =
                Some(openshell_core::proto::SandboxConfigurationAdmission {
                    state: openshell_core::proto::ConfigurationAdmissionState::Rejected as i32,
                    error: "PRIVATE_SENTINEL".into(),
                    ..Default::default()
                });
        }
    }
    run(&["plan", "-input=false", "-out=rejected.plan"], true);
    let started = std::time::Instant::now();
    run(&["apply", "-input=false", "rejected.plan"], false);
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    let rejected: Value = serde_json::from_slice(&run(&["show", "-json"], true)).unwrap();
    let rejection = rejected["values"]["root_module"]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["address"] == "data.nemoclaw_sandbox_readiness.assistant")
        .unwrap();
    let message = rejection["values"]["error_message"].as_str().unwrap();
    assert!(
        message.contains("sandbox/assistant: OpenShell configuration rejected"),
        "{message}"
    );
    assert!(
        message.contains("inspect the sandbox configuration"),
        "{message}"
    );
    assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
    assert_eq!(rejection["values"]["ready"], false);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    // Teardown omits observations so an unavailable runtime cannot block deletion.
    graph.as_object_mut().unwrap().remove("data");
    graph.as_object_mut().unwrap().remove("output");
    graph["provider"]["nemoclaw"]["destroy"] = json!(true);
    graph["provider"]["openshell"]["destroy"] = json!(true);
    let mut workspace = graph["resource"]["openshell_workspace"].clone();
    workspace["deployment"]
        .as_object_mut()
        .unwrap()
        .remove("depends_on");
    workspace["deployment"]["lifecycle"] = json!({"prevent_destroy":true});
    graph["resource"] = json!({"openshell_workspace":workspace});
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    run(
        &["apply", "-auto-approve", "-input=false", "-no-color"],
        true,
    );
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}
