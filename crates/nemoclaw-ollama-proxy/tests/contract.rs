// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The proxy contract against a fake loopback Ollama daemon.
#![cfg(target_os = "linux")]

use nemoclaw_ollama_proxy::{Proxy, Settings, load_key};
use serde_json::json;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

#[derive(Default)]
struct Daemon {
    digest: String,
    redirect: bool,
    // (method, path, authorization header)
    calls: Vec<(String, String, Option<String>)>,
}

/// A minimal HTTP/1.1 daemon: inventory on GET, a two-event stream on POST.
async fn daemon(state: Arc<Mutex<Daemon>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let state = state.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    head.push(socket.read_u8().await.unwrap());
                }
                let head = String::from_utf8(head).unwrap();
                let mut lines = head.lines();
                let mut start = lines.next().unwrap().split(' ');
                let (method, path) = (start.next().unwrap(), start.next().unwrap());
                let header = |name: &str| {
                    head.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case(name)
                            .then(|| value.trim().to_owned())
                    })
                };
                let mut body = vec![0; header("content-length").map_or(0, |n| n.parse().unwrap())];
                socket.read_exact(&mut body).await.unwrap();
                let (digest, redirect) = {
                    let mut state = state.lock().unwrap();
                    state
                        .calls
                        .push((method.into(), path.into(), header("authorization")));
                    (state.digest.clone(), state.redirect)
                };
                let response = if method == "GET" {
                    let body =
                        json!({"models": [{"name": "qwen3:4b", "digest": digest, "size": 100}]})
                            .to_string();
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                } else if redirect {
                    "HTTP/1.1 302 Found\r\nLocation: http://example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
                } else {
                    let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
                    assert_eq!(request["model"], "qwen3:4b");
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {\"fixture\":true}\n\ndata: [DONE]\n\n".into()
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    port
}

struct Running {
    port: u16,
    key: String,
    state: Arc<Mutex<Daemon>>,
    _root: tempfile::TempDir,
}

async fn start() -> Running {
    let state = Arc::new(Mutex::new(Daemon {
        digest: "a".repeat(64),
        ..Daemon::default()
    }));
    let upstream = daemon(state.clone()).await;
    let root = tempfile::tempdir().unwrap();
    let settings = Settings {
        endpoint: "http://127.0.0.1:0/v1".into(),
        upstream: format!("http://127.0.0.1:{upstream}/v1"),
        model: "qwen3:4b".into(),
        digest: "a".repeat(64),
    };
    let (proxy, listener) = Proxy::start(settings, root.path(), Path::new("/proc/net"))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(proxy.serve(listener));
    Running {
        port,
        key: load_key(root.path()).unwrap(),
        state,
        _root: root,
    }
}

/// Send raw bytes so tests control every header; return the status and body.
async fn raw(port: u16, request: &str) -> (u16, String) {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    // A refused connection may be reset rather than closed; both mean no response.
    let mut response = String::new();
    if socket.write_all(request.as_bytes()).await.is_err()
        || socket.read_to_string(&mut response).await.is_err()
    {
        return (0, String::new());
    }
    let status = response
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = response.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    (status, body.to_owned())
}

fn request(method: &str, path: &str, token: Option<&str>, body: &str) -> String {
    let authorization = token.map_or(String::new(), |token| {
        format!("Authorization: Bearer {token}\r\n")
    });
    format!(
        "{method} {path} HTTP/1.1\r\nHost: proxy\r\n{authorization}Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn upstream_calls(running: &Running) -> Vec<(String, String, Option<String>)> {
    running.state.lock().unwrap().calls.clone()
}

#[tokio::test]
async fn authentication_comes_before_any_daemon_contact() {
    let running = start().await;
    let before = upstream_calls(&running).len();
    for token in [None, Some("wrong")] {
        assert_eq!(
            raw(running.port, &request("GET", "/v1/models", token, ""))
                .await
                .0,
            401
        );
    }
    let twice = format!(
        "GET /v1/models HTTP/1.1\r\nHost: proxy\r\nAuthorization: Bearer {0}\r\nAuthorization: Bearer {0}\r\n\r\n",
        running.key
    );
    assert_eq!(raw(running.port, &twice).await.0, 401);
    assert_eq!(upstream_calls(&running).len(), before);
}

#[tokio::test]
async fn only_the_pinned_model_and_two_routes_are_exposed() {
    let running = start().await;
    let key = Some(running.key.as_str());
    assert_eq!(
        raw(running.port, &request("POST", "/api/pull", key, "{}"))
            .await
            .0,
        404
    );
    assert_eq!(
        raw(
            running.port,
            &request("GET", "/v1/chat/completions", key, "")
        )
        .await
        .0,
        404
    );
    assert_eq!(
        raw(running.port, &request("GET", "/v1/models?all", key, ""))
            .await
            .0,
        404
    );
    let other = r#"{"model":"other"}"#;
    assert_eq!(
        raw(
            running.port,
            &request("POST", "/v1/chat/completions", key, other)
        )
        .await
        .0,
        403
    );
    assert_eq!(
        raw(
            running.port,
            &request("POST", "/v1/chat/completions", key, "[]")
        )
        .await
        .0,
        403
    );
    assert_eq!(
        raw(
            running.port,
            &request("POST", "/v1/chat/completions", key, "{")
        )
        .await
        .0,
        400
    );
    let (status, body) = raw(running.port, &request("GET", "/v1/models", key, "")).await;
    assert_eq!(status, 200);
    let models: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        models,
        json!({"object": "list", "data": [{"id": "qwen3:4b", "object": "model", "owned_by": "ollama"}]})
    );
    assert!(
        upstream_calls(&running)
            .iter()
            .all(|(method, _, _)| method == "GET")
    );
}

#[tokio::test]
async fn completions_stream_without_forwarding_the_credential() {
    let running = start().await;
    let body = r#"{"model":"qwen3:4b","stream":true}"#;
    let (status, response) = raw(
        running.port,
        &request("POST", "/v1/chat/completions", Some(&running.key), body),
    )
    .await;
    assert_eq!(status, 200);
    assert!(response.contains("data: [DONE]"), "{response}");
    let posts: Vec<_> = upstream_calls(&running)
        .into_iter()
        .filter(|(method, _, _)| method == "POST")
        .collect();
    assert_eq!(
        posts,
        [("POST".into(), "/v1/chat/completions".into(), None)]
    );
}

#[tokio::test]
async fn framing_and_size_limits_are_enforced() {
    let running = start().await;
    let key = &running.key;
    let chunked = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: proxy\r\nAuthorization: Bearer {key}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"
    );
    assert_eq!(raw(running.port, &chunked).await.0, 400);
    // Conflicting lengths are the smuggling case; hyper rejects them while parsing.
    let conflicting = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: proxy\r\nAuthorization: Bearer {key}\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{{}}"
    );
    assert_eq!(raw(running.port, &conflicting).await.0, 400);
    assert_eq!(
        raw(
            running.port,
            &request("POST", "/v1/chat/completions", Some(key), "")
        )
        .await
        .0,
        413
    );
    let oversized = format!(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: proxy\r\nAuthorization: Bearer {key}\r\nContent-Length: {}\r\n\r\n",
        (4 << 20) + 1
    );
    assert_eq!(raw(running.port, &oversized).await.0, 413);
}

#[tokio::test]
async fn daemon_changes_fail_closed() {
    let running = start().await;
    let key = Some(running.key.as_str());
    running.state.lock().unwrap().redirect = true;
    let body = r#"{"model":"qwen3:4b"}"#;
    assert_eq!(
        raw(
            running.port,
            &request("POST", "/v1/chat/completions", key, body)
        )
        .await
        .0,
        502
    );
    running.state.lock().unwrap().digest = "b".repeat(64);
    assert_eq!(
        raw(running.port, &request("GET", "/v1/models", key, ""))
            .await
            .0,
        502
    );
}

#[tokio::test]
async fn startup_refuses_a_changed_model_before_listening() {
    let state = Arc::new(Mutex::new(Daemon {
        digest: "b".repeat(64),
        ..Daemon::default()
    }));
    let upstream = daemon(state).await;
    let root = tempfile::tempdir().unwrap();
    let settings = Settings {
        endpoint: "http://127.0.0.1:0/v1".into(),
        upstream: format!("http://127.0.0.1:{upstream}/v1"),
        model: "qwen3:4b".into(),
        digest: "a".repeat(64),
    };
    let error = Proxy::start(settings, root.path(), Path::new("/proc/net"))
        .await
        .err()
        .unwrap();
    assert!(error.0.contains("digest changed"), "{error}");
}

#[tokio::test]
async fn connections_beyond_the_limit_are_closed() {
    let running = start().await;
    let mut idle = Vec::new();
    for _ in 0..32 {
        idle.push(
            TcpStream::connect(("127.0.0.1", running.port))
                .await
                .unwrap(),
        );
    }
    // Let the proxy accept every idle connection before the next one.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (status, _) = raw(
        running.port,
        &request("GET", "/v1/models", Some(&running.key), ""),
    )
    .await;
    assert_eq!(
        status, 0,
        "the 33rd connection must close without a response"
    );
    drop(idle);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let (status, _) = raw(
        running.port,
        &request("GET", "/v1/models", Some(&running.key), ""),
    )
    .await;
    assert_eq!(status, 200);
}
