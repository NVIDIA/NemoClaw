// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_e2e::{docker, openshell::Fixture};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated engine and gateway fixtures"]
async fn managed_gateway_exit_preserves_bootstrap_state_and_allows_recovery_or_teardown() {
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").unwrap());
    let provider = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").unwrap());
    assert!(tofu.is_absolute() && provider.is_absolute());
    let gateway = Fixture::start().await;
    let references: Vec<Value> = serde_json::from_str(include_str!(
        "../../nemoclaw-provider/src/managed/reference.json"
    ))
    .unwrap();
    let mut spec: nemoclaw_sdk::managed::Spec =
        serde_json::from_str(references[0]["spec"].as_str().unwrap()).unwrap();
    spec.gateway.endpoint = gateway.endpoint.clone();
    let name = spec.name.clone();
    let owner = spec.owner.clone();
    let running = Arc::new(AtomicBool::new(false));
    let status = running.clone();
    let engine = docker::Fixture::start(move |request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/containers/bound/json");
        let active = status.load(Ordering::SeqCst);
        Some((200, serde_json::to_vec(&json!({"Id":"bound","Name":format!("/{name}"),
            "Config":{"Labels":{"nemoclaw.nvidia.com/uid":owner}},
            "State":{"Running":active,"Status":if active {"running"} else {"exited"},"ExitCode":42,"Error":"PRIVATE_SENTINEL"}
        })).unwrap()))
    }).await;
    spec.gateway.engine = engine.endpoint.clone();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(root.to_str().unwrap()).unwrap())).unwrap();
    let mut graph = json!({
        "terraform":{"required_version":"= 1.12.6","required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},
        "provider":{"nemoclaw":{"endpoint":gateway.endpoint}},
        "resource":{"terraform_data":{"bootstrap":{"input":"bound"}}},
        "data":{"nemoclaw_gateway_capabilities":{"current":{
            "required_compute_drivers":["docker"],"wait_timeout_seconds":90,
            "managed_spec":spec.json().unwrap(),"container_id":"${terraform_data.bootstrap.output}",
            "read_trigger":"${timestamp() != \"\"}",
            "lifecycle":{"postcondition":[{"condition":"${self.compatible}","error_message":"Gateway incompatible"}]}
        }}}
    });
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = Command::new(&tofu)
            .args(args)
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("CHECKPOINT_DISABLE", "1")
            .env("TF_IN_AUTOMATION", "1")
            .output()
            .unwrap();
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.success(), success, "{text}");
        text
    };
    run(&["validate", "-no-color"], true);
    run(
        &["plan", "-input=false", "-no-color", "-out=first.plan"],
        true,
    );
    assert_eq!(gateway.state.lock().unwrap().gateway_reads, 0);
    let started = Instant::now();
    let failure = run(&["apply", "-input=false", "-no-color", "first.plan"], false);
    assert!(started.elapsed() < Duration::from_secs(5), "{failure}");
    for expected in [
        spec.name.as_str(),
        "exit code 42",
        "docker logs",
        "resources retained",
    ] {
        assert!(failure.contains(expected), "{failure}");
    }
    assert!(!failure.contains("PRIVATE_SENTINEL"), "{failure}");
    let state_path = root.join("terraform.tfstate");
    let first = fs::read(&state_path).unwrap();
    let state: Value = serde_json::from_slice(&first).unwrap();
    assert!(state["resources"].as_array().unwrap().iter().any(
        |r| r["type"] == "terraform_data" && r["instances"][0]["attributes"]["id"].is_string()
    ));
    running.store(true, Ordering::SeqCst);
    run(
        &["apply", "-auto-approve", "-input=false", "-no-color"],
        true,
    );
    nemoclaw_e2e::assert_same_managed_resources(&fs::read(&state_path).unwrap(), &first);
    running.store(false, Ordering::SeqCst);
    run(
        &["plan", "-input=false", "-no-color", "-out=recheck.plan"],
        true,
    );
    let started = Instant::now();
    run(
        &["apply", "-input=false", "-no-color", "recheck.plan"],
        false,
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    nemoclaw_e2e::assert_same_managed_resources(&fs::read(&state_path).unwrap(), &first);
    graph.as_object_mut().unwrap().remove("data");
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    run(
        &["destroy", "-auto-approve", "-input=false", "-no-color"],
        true,
    );
    assert_eq!(gateway.state.lock().unwrap().effects, 0);
}
