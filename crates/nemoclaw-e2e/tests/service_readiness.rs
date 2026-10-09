// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_e2e::tofu::TofuWorkspace;
use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated SSH fixture"]
async fn standalone_readiness_defers_to_apply_rechecks_unchanged_services_and_allows_destroy() {
    standalone_readiness(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated SSH fixture"]
async fn standalone_proxy_readiness_rechecks_identity_and_credentials_without_sdk_or_gateway() {
    standalone_readiness(true).await;
}

async fn standalone_readiness(proxy: bool) {
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").unwrap());
    let provider = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").unwrap());
    assert!(tofu.is_absolute() && provider.is_absolute());
    let directory = TofuWorkspace::new(tofu, provider);
    let root = directory.path();
    fs::create_dir(root.join("bin")).unwrap();
    std::os::unix::fs::symlink(
        std::env::var("CARGO_BIN_EXE_nemoclaw-e2e-ssh-fixture")
            .expect("Cargo sets the fixture executable path"),
        root.join("bin/ssh"),
    )
    .unwrap();
    let document = Document::parse(
        include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml").as_slice(),
    )
    .unwrap();
    let mut document = serde_json::to_value(document).unwrap();
    document["spec"]["gateway"] = json!({"management":"external","endpoint":"http://127.0.0.1:1"});
    document["spec"]["services"]["qwen"]["placement"] =
        json!({"engine":"ssh://operator@gpu-box","networkCidr":"172.30.119.0/24"});
    document["spec"]["services"]["qwen"]["publication"] =
        json!({"endpoint":"http://10.0.0.8:18888/v1","bindAddress":"10.0.0.8"});
    let document = Document::parse(document.to_string().as_bytes()).unwrap();
    let generations = ["workspace", "provider", "sandbox", "inference_service"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let target = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "inference_service")
        .unwrap();
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    let model_changed = Arc::new(AtomicBool::new(false));
    let changed = model_changed.clone();
    let mutations = Arc::new(Mutex::new(Vec::new()));
    let seen = mutations.clone();
    let server = nemoclaw_e2e::http_fixture::Fixture::start_tcp(move |request| {
        if request.method != "GET" || request.path != "/api/tags" {
            seen.lock()
                .unwrap()
                .push(format!("{} {}", request.method, request.path));
            return Some((400, Vec::new()));
        }
        let digest = if changed.load(Ordering::SeqCst) {
            "b"
        } else {
            "a"
        }
        .repeat(64);
        let body = json!({"models":[{"name":"qwen3:0.6b","digest":digest,"size":42}]});
        Some((200, body.to_string().into_bytes()))
    })
    .await;
    let upstream = format!("{}/v1", server.endpoint);
    // Readiness takes the contract the container runs with, as a runtime
    // contract data source computes it.
    let (name, contract) = if proxy {
        (
            "nc-0123456789abcdef-ollama-proxy-local".to_owned(),
            json!({"upstream":upstream, "endpoint":"http://127.0.0.1:11435/v1",
                "model":"qwen3:0.6b", "digest":"a".repeat(64)})
            .to_string(),
        )
    } else {
        let spec: nemoclaw_sdk::managed::Spec =
            serde_json::from_str(&target.values["spec"]).unwrap();
        (
            spec.name.clone(),
            spec.runtime_configuration().unwrap().to_owned(),
        )
    };
    let engine = json!({"effects":0,"container":{"Id":"owned","Name":format!("/{name}"),"State":{"Running":true,"StartedAt":"2026-09-15T00:00:00Z"}}});
    fs::write(root.join("engine.json"), engine.to_string()).unwrap();
    let status = |phase: &str| {
        if proxy {
            model_changed.store(phase == "model", Ordering::SeqCst);
            let mut observed = engine.clone();
            observed["container"]["State"]["Running"] = json!(phase != "stopped");
            if phase == "identity" {
                observed["container"]["Id"] = json!("other");
            }
            fs::write(root.join("engine.json"), observed.to_string()).unwrap();
            fs::write(
                root.join("fixture.json"),
                json!({
                    "stats":{"/data/inference-key":{"name":"inference-key", "size":64,
                        "mode":if phase == "loading" { 420 } else { 384 },
                        "mtime":"2026-09-15T00:00:00Z", "linkTarget":""}},
                    "files":{"/data/inference-key":{"raw":"a".repeat(64)}}
                })
                .to_string(),
            )
            .unwrap();
        } else {
            fs::write(root.join("fixture.json"),json!({"files":{"/data/status.json":{"phase":phase,"updated":"2026-09-15T00:00:01Z","pid":42,"detail":""}}}).to_string()).unwrap();
        }
    };
    let control = |value: Value| fs::write(root.join("control.json"), value.to_string()).unwrap();
    status("ready");
    control(json!({"transport_failure":true}));
    // Each check makes several SSH fixture round trips, so a 1-second wait
    // timed out on a slow macOS runner. A managed service that is still loading
    // fails only when the wait expires, so its wait stays short; every expected
    // proxy failure is immediate, so the proxy wait can be generous.
    let wait = if proxy { 30 } else { 3 };
    let graph = json!({"terraform":{"required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},"provider":{"nemoclaw":{}},"data":{"nemoclaw_service_readiness":{"model":{"engine":"ssh://operator@gpu-box","name":name,"contract":contract,"container_id":"owned","wait_timeout_seconds":wait,"read_trigger":"${timestamp() != \"\"}"}}},"resource":{"terraform_data":{"consumer":{"input":"${data.nemoclaw_service_readiness.model.ready}"}}}});
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = directory
            .command()
            .args(args)
            .env("NEMOCLAW_TEST_REMOTE", root)
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    root.join("bin").display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    run(&["validate"], true);
    run(&["plan", "-input=false", "-out=ready.plan"], true);
    run(&["apply", "-input=false", "ready.plan"], false);
    control(json!({}));
    run(&["apply", "-input=false", "-auto-approve"], true);
    let state = || {
        serde_json::from_slice::<Value>(&fs::read(root.join("terraform.tfstate")).unwrap()).unwrap()
    };
    let consumer_id = |state: &Value| {
        state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["type"] == "terraform_data")
            .unwrap()["instances"][0]["attributes"]["id"]
            .clone()
    };
    let id = consumer_id(&state());
    if proxy {
        control(json!({"defer_key_once":true}));
        run(&["apply", "-input=false", "-auto-approve"], true);
        assert_eq!(consumer_id(&state()), id);
    }
    for phase in if proxy {
        vec!["stopped", "loading", "identity", "model"]
    } else {
        vec!["stopped", "loading"]
    } {
        run(&["plan", "-input=false", "-out=ready.plan"], true);
        status(phase);
        run(&["apply", "-input=false", "ready.plan"], false);
        assert_eq!(consumer_id(&state()), id);
        status("ready");
        run(&["apply", "-input=false", "-auto-approve"], true);
        assert_eq!(consumer_id(&state()), id);
    }
    control(json!({"transport_failure":true}));
    drop(server);
    assert_eq!(
        *mutations.lock().unwrap(),
        Vec::<String>::new(),
        "readiness must not request generation or mutate models"
    );
    run(&["destroy", "-input=false", "-auto-approve"], true);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(root.join("engine.json")).unwrap()).unwrap(),
        engine
    );
}
