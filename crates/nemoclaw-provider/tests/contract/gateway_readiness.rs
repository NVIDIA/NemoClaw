// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use crate::{http_fixture as docker, openshell::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated engine and gateway fixtures"]
async fn managed_gateway_exit_preserves_bootstrap_state_and_allows_recovery_or_teardown() {
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").unwrap());
    let provider = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").unwrap());
    assert!(tofu.is_absolute() && provider.is_absolute());
    let gateway = Fixture::start().await;
    let name = "nc-0123456789abcdef-gateway".to_owned();
    let owner = "302ff5e1-088d-42ce-959f-4ff4c3570c13".to_owned();
    let (container_name, container_owner) = (name.clone(), owner.clone());
    let running = Arc::new(AtomicBool::new(false));
    let status = running.clone();
    let engine = docker::Fixture::start(move |request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/containers/bound/json");
        let active = status.load(Ordering::SeqCst);
        Some((200, serde_json::to_vec(&json!({"Id":"bound","Name":format!("/{container_name}"),
            "Config":{"Labels":{"nemoclaw.nvidia.com/uid":container_owner}},
            "State":{"Running":active,"Status":if active {"running"} else {"exited"},"ExitCode":42,"Error":"PRIVATE_SENTINEL"}
        })).unwrap()))
    }).await;
    let directory = TofuWorkspace::new(tofu, provider);
    let root = directory.path();
    let mut graph = json!({
        "terraform":{"required_version":"= 1.12.6","required_providers":{
            "nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"},
            "openshell":{"source":"registry.opentofu.org/nvidia/openshell"}
        }},
        "provider":{"nemoclaw":{},"openshell":{"endpoint":gateway.endpoint}},
        "resource":{"terraform_data":{"bootstrap":{"input":"bound"}}},
        "data":{
            "nemoclaw_gateway_readiness":{"current":{
                "engine":engine.endpoint,"container_id":"${terraform_data.bootstrap.output}",
                "name":name,"owner":owner,"endpoint":gateway.endpoint,
                "wait_timeout_seconds":90,"read_trigger":"${timestamp() != \"\"}"
            }},
            "openshell_gateway":{"current":{
                "required_compute_drivers":["docker"],"wait_timeout_seconds":90,
                "read_trigger":"${data.nemoclaw_gateway_readiness.current.ready}",
                "lifecycle":{"postcondition":[{"condition":"${self.compatible}","error_message":"Gateway incompatible"}]}
            }}
        }
    });
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = directory.command().args(args).output().unwrap();
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
    assert_eq!(gateway.state.lock().unwrap().health_reads, 0, "{failure}");
    for expected in [
        name.as_str(),
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
    crate::assert_same_managed_resources(&fs::read(&state_path).unwrap(), &first);
    assert!(gateway.state.lock().unwrap().health_reads > 0);
    assert!(gateway.state.lock().unwrap().gateway_reads > 0);
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
    crate::assert_same_managed_resources(&fs::read(&state_path).unwrap(), &first);
    graph.as_object_mut().unwrap().remove("data");
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    run(
        &["destroy", "-auto-approve", "-input=false", "-no-color"],
        true,
    );
    assert_eq!(gateway.state.lock().unwrap().effects, 0);
}
