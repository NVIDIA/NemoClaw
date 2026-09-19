// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use nemoclaw_sdk::{
    backend::{Backend, Row},
    compile::{Generations, targets},
    config::Document,
    docker::Engine,
    services::installers::ollama::ProxyBackend,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    process::Command,
    sync::{Arc, Mutex},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROXY: &str = "ollama_proxy";
const STORAGE: &str = "ollama_proxy_storage";
const MODEL: &str = "ollama_external_model";

async fn ensure(backend: &ProxyBackend, rows: &mut BTreeMap<String, Row>) {
    for kind in [STORAGE, MODEL, PROXY] {
        let mutation = backend.ensure(kind, &rows[kind]).await;
        assert!(mutation.error().is_none(), "{kind}: {:?}", mutation.error());
        rows.insert(kind.into(), mutation.state().unwrap().clone());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE loaded in local Docker; creates only owned proxy resources"]
async fn proxy_backend_retains_key_and_never_manages_daemon_or_model() {
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
            let body = json!({"models":[{"name":"qwen3:0.6b","digest":observed.lock().unwrap().clone(),"size":42}]}).to_string();
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
    // Exercise only the proxy backend. The inherited gateway engine is configuration;
    // no gateway or sandbox is created, and no simulated gateway is presented as managed.
    let document = Document::parse(
        proxy_configuration(&uid, "http://127.0.0.1:17671", &image, &endpoint, &upstream)
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let mut rows: BTreeMap<String, Row> = targets(&document, &generations)
        .unwrap()
        .into_iter()
        .filter(|target| ProxyBackend::supports(&target.kind))
        .map(|target| (target.kind, target.values))
        .collect();
    assert_eq!(rows.len(), 3);
    let name = rows[PROXY]["name"].clone();
    let engine = Engine::connect(&document.spec.gateway.engine).unwrap();
    assert!(
        engine.image(&image).await.unwrap().is_some(),
        "load the explicitly selected proxy image before testing"
    );
    let backend = ProxyBackend::new(engine.clone());
    assert!(
        backend
            .read(PROXY, &rows[PROXY], false)
            .await
            .unwrap()
            .is_none()
    );
    assert!(engine.container(&name).await.unwrap().is_none());
    ensure(&backend, &mut rows).await;
    let id = engine.container(&name).await.unwrap().unwrap().id.unwrap();
    let key = String::from_utf8(
        engine
            .read_file(&id, "/data/inference-key", 64)
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(key.len(), 64);
    assert!(!document.yaml().unwrap().contains(&key));
    assert!(!serde_json::to_string(&rows).unwrap().contains(&key));
    let established = rows.clone();
    ensure(&backend, &mut rows).await;
    assert_eq!(rows, established);
    for kind in [STORAGE, MODEL, PROXY] {
        assert_eq!(
            backend
                .read(kind, &rows[kind], false)
                .await
                .unwrap()
                .as_ref(),
            Some(&rows[kind])
        );
    }
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
    *digest.lock().unwrap() = "b".repeat(64);
    assert!(backend.read(MODEL, &rows[MODEL], false).await.is_err());
    assert!(backend.ensure(PROXY, &rows[PROXY]).await.error().is_some());
    assert_eq!(rows, established);
    assert_eq!(
        engine.container(&name).await.unwrap().unwrap().id.as_ref(),
        Some(&id)
    );
    *digest.lock().unwrap() = "a".repeat(64);
    assert!(
        Command::new("docker")
            .args([
                "--host",
                &document.spec.gateway.engine,
                "stop",
                "--time",
                "5",
                &id
            ])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert_eq!(
        backend
            .read(PROXY, &rows[PROXY], false)
            .await
            .unwrap()
            .unwrap()["running"],
        "false"
    );
    ensure(&backend, &mut rows).await;
    assert_eq!(
        engine
            .read_file(&id, "/data/inference-key", 64)
            .await
            .unwrap()
            .unwrap(),
        key.as_bytes()
    );
    assert!(backend.remove(PROXY, &rows[PROXY], false).await.is_err());
    backend.remove(PROXY, &rows[PROXY], true).await.unwrap();
    assert!(
        backend
            .read(PROXY, &rows[PROXY], true)
            .await
            .unwrap()
            .is_none()
    );
    rows.get_mut(PROXY).unwrap().remove("id");
    // Release only the confirmed-absent process binding; storage keeps its identity.
    ensure(&backend, &mut rows).await;
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
    assert_eq!(rows[STORAGE], established[STORAGE]);
    backend.remove(PROXY, &rows[PROXY], true).await.unwrap();
    backend.remove(MODEL, &rows[MODEL], true).await.unwrap();
    assert!(backend.remove(STORAGE, &rows[STORAGE], true).await.is_err());
    let volume = format!("{name}-auth");
    let retained = engine.volume(&volume).await.unwrap().unwrap();
    assert_eq!(
        retained.labels["nemoclaw.nvidia.com/uid"],
        document.metadata.uid
    );
    assert_eq!(
        retained.labels["nemoclaw.nvidia.com/generation"],
        generations["ollama_proxy"]
    );
    assert!(!server.is_finished());
    assert!(
        Command::new("docker")
            .args([
                "--host",
                &document.spec.gateway.engine,
                "volume",
                "rm",
                &volume
            ])
            .output()
            .unwrap()
            .status
            .success()
    );
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
    value["spec"]["gateway"]["endpoint"] = json!(gateway_endpoint);
    let provider = &mut value["spec"]["inferenceProviders"][0];
    provider["serviceRef"] = json!("ollama-auth");
    value["spec"]["services"] = json!({"ollama-auth": {
        "kind":"ollamaProxy",
        "image":image,
        "imagePullPolicy":"Never",
        "endpoint":endpoint,
        "upstream":{"endpoint":upstream,"model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}
    }});
    value
}

#[test]
fn live_proxy_configuration_parses_without_live_resources() {
    let value = proxy_configuration(
        "87d485ad-fba7-4197-9eaa-aa97cc97446b",
        "http://127.0.0.1:17671",
        &format!("example/proxy@sha256:{}", "a".repeat(64)),
        "http://127.0.0.1:11435/v1",
        "http://127.0.0.1:11434/v1",
    );
    Document::parse(value.to_string().as_bytes()).unwrap();
}
