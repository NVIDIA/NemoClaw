// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated SSH fixture"]
async fn standalone_readiness_defers_to_apply_rechecks_unchanged_services_and_allows_destroy() {
    standalone_readiness(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated SSH fixture"]
async fn standalone_proxy_readiness_rechecks_identity_and_credentials_without_sdk_or_gateway() {
    standalone_readiness(true).await;
}

async fn standalone_readiness(proxy: bool) {
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").unwrap());
    let provider = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").unwrap());
    assert!(tofu.is_absolute() && provider.is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir(root.join("bin")).unwrap();
    fs::write(
        root.join("bin/ssh"),
        include_bytes!("fixtures/remote_ssh.py"),
    )
    .unwrap();
    fs::set_permissions(root.join("bin/ssh"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(root.to_str().unwrap()).unwrap())).unwrap();
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
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let model_changed = Arc::new(AtomicBool::new(false));
    let changed = model_changed.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(
                request.starts_with(b"GET /api/tags HTTP/1.1\r\n"),
                "readiness must not request generation or mutate models"
            );
            let digest = if changed.load(Ordering::SeqCst) {
                "b"
            } else {
                "a"
            }
            .repeat(64);
            let body =
                json!({"models":[{"name":"qwen3:0.6b","digest":digest,"size":42}]}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let encoded = if proxy {
        json!({"kind":"ollama_proxy", "engine":"ssh://operator@gpu-box", "proxy":{
            "Name":"nc-0123456789abcdef-ollama-proxy-local", "Owner":document.metadata.uid,
            "Generation":"a".repeat(32), "Image":format!("proxy@sha256:{}", "a".repeat(64)),
            "BindAddress":"127.0.0.1:11435", "Settings":{"upstream":upstream,
            "endpoint":"http://127.0.0.1:11435/v1", "model":"qwen3:0.6b", "digest":"a".repeat(64)}
        }})
        .to_string()
    } else {
        target.values["spec"].clone()
    };
    let spec: Value = serde_json::from_str(&encoded).unwrap();
    let name = if proxy {
        &spec["proxy"]["Name"]
    } else {
        &spec["name"]
    };
    let engine = json!({"effects":0,"container":{"Id":"owned","Name":format!("/{}",name.as_str().unwrap()),"State":{"Running":true,"StartedAt":"2026-09-15T00:00:00Z"}}});
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
    let graph = json!({"terraform":{"required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}},"provider":{"nemoclaw":{"endpoint":"http://127.0.0.1:1"}},"data":{"nemoclaw_service_readiness":{"model":{"spec":encoded,"container_id":"owned","wait_timeout_seconds":1,"read_trigger":"${timestamp() != \"\"}"}}},"resource":{"terraform_data":{"consumer":{"input":"${data.nemoclaw_service_readiness.model.ready}"}}}});
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = Command::new(&tofu)
            .args(args)
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
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
    server.abort();
    run(&["destroy", "-input=false", "-auto-approve"], true);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(root.join("engine.json")).unwrap()).unwrap(),
        engine
    );
}
