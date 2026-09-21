// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document, docker::Engine};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf, process::Command};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn assert_same_bindings(actual: &[u8], expected: &[u8]) {
    fn bindings(bytes: &[u8]) -> std::collections::BTreeMap<String, Value> {
        let state: Value = serde_json::from_slice(bytes).unwrap();
        state["resources"].as_array().unwrap().iter().filter(|r| r["mode"] == "managed").map(|r| {
            let attrs = &r["instances"][0]["attributes"];
            (format!("{}.{}", r["type"].as_str().unwrap(), r["name"].as_str().unwrap()), json!({"id":attrs["id"],"owner":attrs["owner"],"generation":attrs["generation"],"labels":attrs["labels"]}))
        }).collect()
    }
    assert_eq!(bindings(actual), bindings(expected));
}

const ENGINE: &str = "unix:///var/run/docker.sock";

fn docker(args: &[&str]) -> std::process::Output {
    let output = Command::new("docker")
        .args(["--host", ENGINE])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "docker {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

struct OwnedResources {
    name: String,
    uid: String,
}
impl Drop for OwnedResources {
    fn drop(&mut self) {
        // This unique test owns these exact names, including deliberately substituted
        // volumes. Never enumerate or remove another deployment's resources.
        for (kind, name) in [
            ("container", self.name.clone()),
            ("volume", format!("{}-auth", self.name)),
        ] {
            let inspected = Command::new("docker")
                .args(["--host", ENGINE, kind, "inspect", &name])
                .output()
                .unwrap();
            if !inspected.status.success() {
                continue;
            }
            let value: Value = serde_json::from_slice(&inspected.stdout).unwrap();
            let labels = if kind == "container" {
                &value[0]["Config"]["Labels"]
            } else {
                &value[0]["Labels"]
            };
            if labels["nemoclaw.nvidia.com/uid"] == self.uid
                || labels["nemoclaw.experiment"] == self.uid
            {
                let mut command = Command::new("docker");
                command.args(["--host", ENGINE, kind, "rm"]);
                if kind == "container" {
                    command.arg("--force");
                }
                let _ = command.arg(name).output();
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE and NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE/_REPLACEMENT_IMAGE; creates only uniquely owned Docker resources"]
async fn sdk_docker_proxy_lifecycle_preserves_readiness_and_storage_guards() {
    let image = std::env::var("NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE").unwrap();
    let replacement_image = std::env::var("NEMOCLAW_TEST_OLLAMA_PROXY_REPLACEMENT_IMAGE").unwrap();
    assert_ne!(image, replacement_image);
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    assert!(bundle.is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let seed: String = Sha256::digest(directory.path().to_string_lossy().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let uid = format!(
        "{}-{}-{}-{}-{}",
        &seed[..8],
        &seed[8..12],
        &seed[12..16],
        &seed[16..20],
        &seed[20..32]
    );
    let fixture = Fixture::start().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            while !bytes.ends_with(b"\r\n\r\n") {
                bytes.push(socket.read_u8().await.unwrap());
            }
            assert!(
                bytes.starts_with(b"GET /api/tags HTTP/1.1\r\n"),
                "external daemon received a mutation"
            );
            let body = json!({"models":[{"name":"qwen3:0.6b","digest":"a".repeat(64),"size":42}]})
                .to_string();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let endpoint = format!("http://127.0.0.1:{port}/v1");
    let mut document = Document::parse(
        proxy_configuration(&uid, &fixture.endpoint, &image, &endpoint, &upstream)
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    let name = format!("{}-ollama-proxy-ollama-auth", document.workspace());
    let volume = format!("{name}-auth");
    let engine = Engine::connect(ENGINE).unwrap();
    assert!(
        engine.image(&image).await.unwrap().is_some(),
        "load the explicit proxy image first"
    );
    assert!(
        engine.image(&replacement_image).await.unwrap().is_some(),
        "load the explicit replacement proxy image first"
    );
    assert!(engine.container(&name).await.unwrap().is_none());
    assert!(engine.volume(&volume).await.unwrap().is_none());
    let _owned = OwnedResources {
        name: name.clone(),
        uid: uid.clone(),
    };
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    let state_path = directory.path().join("terraform.tfstate");

    // Fail the OpenShell sandbox health check after proxy creation; no proxy process failure is simulated.
    fixture.state.lock().unwrap().health_report =
        Some(json!({"supported":true,"report":null,"reason_code":"fabric_health_timeout"}));
    let error = deployment.apply(&document, &cancel).await.unwrap_err();
    assert!(
        matches!(error, nemoclaw_sdk::Error::Health { .. }),
        "{error}"
    );
    let id = engine.container(&name).await.unwrap().unwrap().id.unwrap();
    let failed = fs::read(&state_path).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_same_bindings(&fs::read(&state_path).unwrap(), &failed);
    assert_eq!(
        engine
            .container(&name)
            .await
            .unwrap()
            .unwrap()
            .id
            .as_deref(),
        Some(id.as_str())
    );
    fixture.state.lock().unwrap().health_report = None;
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    let established = fs::read(&state_path).unwrap();
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_same_bindings(&fs::read(&state_path).unwrap(), &established);
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    let reopened = Deployment::new(directory.path(), &bundle);
    assert_eq!(reopened.export(&cancel).await.unwrap(), document);
    assert!(
        reopened
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    let state: Value = serde_json::from_slice(&established).unwrap();
    assert!(
        state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["type"] == "docker_container"),
        "actual Deployment must delegate container lifecycle"
    );
    let key = engine
        .read_file(&id, "/data/inference-key", 64)
        .await
        .unwrap()
        .unwrap();
    assert!(!String::from_utf8_lossy(&established).contains(std::str::from_utf8(&key).unwrap()));
    // Credentials remain an application contract even when provider apply is a no-op.
    docker(&[
        "exec",
        &id,
        "python3",
        "-c",
        "import os; os.chmod('/data/inference-key', 0o644)",
    ]);
    assert_eq!(deployment.export(&cancel).await.unwrap(), document);
    assert!(deployment.apply(&document, &cancel).await.is_err());
    assert_same_bindings(&fs::read(&state_path).unwrap(), &established);
    docker(&[
        "exec",
        &id,
        "python3",
        "-c",
        "import os; os.chmod('/data/inference-key', 0o600)",
    ]);
    let original_volume = engine.volume(&volume).await.unwrap().unwrap();
    let mut changed = serde_json::to_value(&document).unwrap();
    changed["spec"]["services"]["ollama-auth"]["image"] = json!(replacement_image);
    document = Document::parse(changed.to_string().as_bytes()).unwrap();
    let replacement = deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        replacement
            .changes
            .iter()
            .any(|change| change.resource.starts_with("docker_container.")
                && change.actions.iter().any(|action| action == "create"))
    );
    assert!(!replacement.changes.iter().any(|change| {
        change
            .resource
            .starts_with("nemoclaw_ollama_proxy_storage.")
            || change
                .resource
                .starts_with("nemoclaw_ollama_external_model.")
            || change.resource.starts_with("nemoclaw_provider.")
    }));
    let image_id = engine.container(&name).await.unwrap().unwrap().id.unwrap();
    assert_ne!(image_id, id);
    assert_eq!(
        engine.volume(&volume).await.unwrap().unwrap().created_at,
        original_volume.created_at
    );
    assert_eq!(
        engine
            .read_file(&image_id, "/data/inference-key", 64)
            .await
            .unwrap()
            .unwrap(),
        key
    );
    let id = image_id;
    // Provider reconciliation may recreate disposable compute; credentials
    // must stay in the independently retained volume.
    let retained_volume = engine.volume(&volume).await.unwrap().unwrap();
    docker(&["rm", "--force", &id]);
    let recreation = deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        recreation
            .changes
            .iter()
            .any(|change| change.resource.starts_with("docker_container.")
                && change.actions == ["create"])
    );
    let new_id = engine.container(&name).await.unwrap().unwrap().id.unwrap();
    assert_ne!(new_id, id);
    assert_eq!(
        engine.volume(&volume).await.unwrap().unwrap().created_at,
        retained_volume.created_at
    );
    assert_eq!(
        engine
            .read_file(&new_id, "/data/inference-key", 64)
            .await
            .unwrap()
            .unwrap(),
        key
    );
    let id = new_id;
    docker(&["stop", "--time", "1", &id]);
    let recovered = deployment.apply(&document, &cancel).await.unwrap();
    assert!(recovered.changes.iter().any(|change| {
        change.resource.starts_with("docker_container.")
            && change
                .actions
                .iter()
                .any(|action| action == "update" || action == "create")
    }));
    let restarted = engine.container(&name).await.unwrap().unwrap();
    let id = restarted.id.unwrap();
    assert_eq!(restarted.state.unwrap().running, Some(true));
    let stop_once = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = stop_once.clone();
    let stop_id = id.clone();
    let readiness_failure = Deployment::new(directory.path(), &bundle).with_progress(
        std::sync::Arc::new(move |event| {
            if event == nemoclaw_sdk::Progress::Readiness
                && !stopped.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                docker(&["stop", "--time", "1", &stop_id]);
            }
        }),
    );
    let error = readiness_failure
        .apply(&document, &cancel)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not running"), "{error}");
    assert_eq!(
        engine
            .container(&name)
            .await
            .unwrap()
            .unwrap()
            .id
            .as_deref(),
        Some(id.as_str())
    );
    deployment.apply(&document, &cancel).await.unwrap();
    let recovered = engine.container(&name).await.unwrap().unwrap();
    assert_eq!(
        engine
            .read_file(recovered.id.as_deref().unwrap(), "/data/inference-key", 64)
            .await
            .unwrap()
            .unwrap(),
        key
    );
    assert_eq!(recovered.state.unwrap().running, Some(true));
    let labels = engine.volume(&volume).await.unwrap().unwrap().labels;
    reopened.destroy(&cancel).await.unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
    assert!(engine.volume(&volume).await.unwrap().is_some());
    assert!(fixture.state.lock().unwrap().sandboxes.is_empty());

    // Destroy retains the bound volume. Removing, replacing with foreign labels,
    // and substituting an identically labeled volume must all fail closed.
    docker(&["volume", "rm", &volume]);
    for mode in ["missing", "foreign", "substituted"] {
        if mode != "missing" {
            let mut args = vec!["volume".to_owned(), "create".into()];
            if mode == "substituted" {
                for (key, value) in &labels {
                    args.extend(["--label".into(), format!("{key}={value}")]);
                }
            } else {
                args.extend(["--label".into(), format!("nemoclaw.experiment={uid}")]);
            }
            args.push(volume.clone());
            docker(&args.iter().map(String::as_str).collect::<Vec<_>>());
        }
        let before = fs::read(&state_path).unwrap();
        let error = deployment.apply(&document, &cancel).await.unwrap_err();
        let expected = if mode == "missing" {
            "storage is absent; recreation forbidden"
        } else {
            "observed ownership, generation, or durable identity changed"
        };
        assert!(
            error.to_string().contains(expected),
            "{mode} storage failed for an unrelated reason: {error}"
        );
        assert_eq!(
            fs::read(&state_path).unwrap(),
            before,
            "{mode} storage changed bindings"
        );
        assert!(
            engine.container(&name).await.unwrap().is_none(),
            "{mode} storage recreated container"
        );
        if mode != "missing" {
            docker(&["volume", "rm", &volume]);
        }
    }
    assert!(!server.is_finished());
    server.abort();
}

fn proxy_configuration(
    uid: &str,
    gateway_endpoint: &str,
    image: &str,
    endpoint: &str,
    upstream: &str,
) -> Value {
    let mut value: Value = serde_json::to_value(
        Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml").as_bytes(),
        )
        .unwrap(),
    )
    .unwrap();
    value["metadata"]["uid"] = json!(uid);
    value["spec"]["gateway"] = json!({"management":"external", "endpoint":gateway_endpoint});
    let provider = &mut value["spec"]["inferenceProviders"][0];
    provider["serviceRef"] = json!("ollama-auth");
    value["spec"]["services"] = json!({"ollama-auth": {
        "kind":"ollamaProxy",
        "engine":"unix:///var/run/docker.sock",
        "image":image,
        "imagePullPolicy":"Never",
        "endpoint":endpoint,
        "upstream":{"endpoint":upstream,"model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}
    }});
    value
}
