// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{CancellationToken, Deployment, config::Document, docker::Engine};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE and NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE; creates only owned Docker resources"]
async fn external_ollama_proxy_lifecycle_retains_key_and_never_manages_daemon_or_model() {
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    let image = std::env::var("NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE").unwrap();
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/v1", listener.local_addr().unwrap());
    let digest = Arc::new(Mutex::new("a".repeat(64)));
    let observed = digest.clone();
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
            let body=json!({"models":[{"name":"qwen3:0.6b","digest":observed.lock().unwrap().clone(),"size":42}]}).to_string();
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
    let gateway = Fixture::start().await;
    let mut value: Value = serde_json::to_value(
        Document::parse(
            include_str!("../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml").as_bytes(),
        )
        .unwrap(),
    )
    .unwrap();
    value["metadata"]["uid"] = json!(uid);
    value["spec"]["gateway"]["endpoint"] = json!(gateway.endpoint);
    let provider = &mut value["spec"]["inferenceProviders"][0];
    provider["serviceRef"] = json!("ollama-auth");
    value["spec"]["services"] = json!({"ollama-auth": {
        "kind":"ollamaProxy",
        "management":"managed",
        "runtime":{"provider":"docker","engine":"unix:///var/run/docker.sock","image":image},
        "endpoint":endpoint,
        "upstream":{"endpoint":upstream,"model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}
    }});
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let deployment = Deployment::new(directory.path(), &bundle);
    let cancel = CancellationToken::new();
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(plan.changes.len(), 7);
    let name = format!("{}-ollama-proxy-ollama-auth", document.workspace());
    let engine = Engine::connect("unix:///var/run/docker.sock").unwrap();
    assert!(engine.container(&name).await.unwrap().is_none());
    deployment.apply(&document, &cancel).await.unwrap();
    let container = engine.container(&name).await.unwrap().unwrap();
    let id = container.id.unwrap();
    let key = engine
        .read_file(&id, "/data/inference-key", 64)
        .await
        .unwrap()
        .unwrap();
    let key = String::from_utf8(key).unwrap();
    assert_eq!(key.len(), 64);
    assert!(
        gateway
            .state
            .lock()
            .unwrap()
            .providers
            .values()
            .any(|p| p.credentials.get("OPENAI_API_KEY") == Some(&key))
    );
    for name in ["intent.json", "terraform.tfstate", "main.tf.json"] {
        assert!(
            !std::fs::read_to_string(directory.path().join(name))
                .unwrap()
                .contains(&key)
        );
    }
    let exported = Command::new(bundle.join("bin/nemoclaw"))
        .args(["export", "--state-dir"])
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(
        exported.status.success(),
        "{}",
        String::from_utf8_lossy(&exported.stderr)
    );
    assert_eq!(
        Document::parse(exported.stdout.as_slice()).unwrap(),
        document
    );
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(
        engine.container(&name).await.unwrap().unwrap().id.as_ref(),
        Some(&id)
    );
    let request = |token: String| async move {
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        socket.write_all(format!("GET /v1/models HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut bytes = vec![];
        socket.read_to_end(&mut bytes).await.unwrap();
        String::from_utf8(bytes).unwrap()
    };
    assert!(request("wrong".into()).await.starts_with("HTTP/1.1 401"));
    assert!(request(key.clone()).await.contains("qwen3:0.6b"));
    let saved = std::fs::read(directory.path().join("terraform.tfstate")).unwrap();
    *digest.lock().unwrap() = "b".repeat(64);
    assert!(deployment.plan(&document, &cancel).await.is_err());
    assert!(deployment.export(&cancel).await.is_err());
    assert_eq!(
        std::fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        saved
    );
    *digest.lock().unwrap() = "a".repeat(64);
    assert!(
        Command::new("docker")
            .args(["stop", "--time", "5", &id])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(
        !deployment
            .plan(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(
        engine
            .read_file(&id, "/data/inference-key", 64)
            .await
            .unwrap()
            .unwrap(),
        key.as_bytes()
    );
    let destroyed = Command::new(bundle.join("bin/nemoclaw"))
        .args(["destroy", "--state-dir"])
        .arg(directory.path())
        .output()
        .unwrap();
    assert!(
        destroyed.status.success(),
        "{}",
        String::from_utf8_lossy(&destroyed.stderr)
    );
    assert!(engine.container(&name).await.unwrap().is_none());
    deployment.apply(&document, &cancel).await.unwrap();
    let recreated = engine.container(&name).await.unwrap().unwrap().id.unwrap();
    assert_ne!(recreated, id);
    assert_eq!(
        engine
            .read_file(&recreated, "/data/inference-key", 64)
            .await
            .unwrap()
            .unwrap(),
        key.as_bytes()
    );
    deployment.destroy(&cancel).await.unwrap();
    let volume = format!("{name}-auth");
    let retained = engine.volume(&volume).await.unwrap().unwrap();
    assert_eq!(
        retained.labels["nemoclaw.nvidia.com/uid"],
        document.metadata.uid
    );
    // Test-owned credential storage only; the external fixture server remains running until now.
    assert!(!server.is_finished());
    assert!(
        Command::new("docker")
            .args(["volume", "rm", &volume])
            .output()
            .unwrap()
            .status
            .success()
    );
    server.abort();
}
