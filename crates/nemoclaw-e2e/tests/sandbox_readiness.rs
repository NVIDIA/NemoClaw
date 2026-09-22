// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated gateway fixture"]
async fn standalone_sandbox_completion_runs_in_apply_and_retains_failed_health_observations() {
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").unwrap());
    let provider = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let fixture = Fixture::start().await;
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(root.to_str().unwrap()).unwrap())).unwrap();
    let mut document = Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_slice(),
    )
    .unwrap();
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let generations = ["workspace", "provider", "sandbox"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let mut graph = compile::compile(&document, &generations, "0.1.0").unwrap();
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = Command::new(&tofu)
            .args(args)
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap();
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
    let report: Value =
        serde_json::from_str(health["values"]["health_json"].as_str().unwrap()).unwrap();
    assert_eq!(report["reason_code"], "fabric_health_timeout");
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
            .all(|cmd| !cmd.iter().any(|part| part == "health"))
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
            .any(|cmd| cmd.last().is_some_and(|part| part == "health"))
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
    // Teardown omits observations so an unavailable runtime cannot block deletion.
    graph.as_object_mut().unwrap().remove("data");
    graph["provider"]["nemoclaw"]["destroy"] = json!(true);
    let mut workspace = graph["resource"]["nemoclaw_workspace"].clone();
    workspace["deployment"]
        .as_object_mut()
        .unwrap()
        .remove("depends_on");
    workspace["deployment"]["lifecycle"] = json!({"prevent_destroy":true});
    graph["resource"] = json!({"nemoclaw_workspace":workspace});
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    run(
        &["apply", "-auto-approve", "-input=false", "-no-color"],
        true,
    );
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());
}
