// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Host checks in `host/main.tf` against a fake engine and a fake HTTP
//! server for health and models. `host/tests` covers passing checks; failed
//! reads fail the plan, which `tofu test` cannot expect.

use crate::http_fixture::Fixture;
use serde_json::json;
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// The fixtures, which pass every check while `healthy` holds, and the
/// variables that name them.
struct Host {
    healthy: Arc<AtomicBool>,
    _fixtures: [Fixture; 2],
    variables: Vec<(&'static str, String)>,
}

impl Host {
    async fn start() -> Self {
        let healthy = Arc::new(AtomicBool::new(true));
        let state = healthy.clone();
        let engine = Fixture::engine(move |request| {
            assert_eq!(request.method, "GET", "a host check must not mutate");
            let healthy = state.load(Ordering::SeqCst);
            let body = if request.path.starts_with("/images/") {
                let backend = if healthy { "vllm" } else { "ollama" };
                json!({"Id": "sha256:runtime", "Os": "linux", "Architecture": "arm64",
                    "Config": {"Labels": {"org.nemoclaw.backend": backend}}})
            } else if request.path == "/containers/application-id/json" {
                let health = if healthy { "healthy" } else { "unhealthy" };
                json!({"Id": "application-id", "Name": "/application",
                    "Config": {"Labels": {"nemoclaw.nvidia.com/owner": "deployment"}},
                    "State": {"Running": true, "StartedAt": "2026-01-02T00:00:00Z", "Health": {"Status": health}}})
            } else if request.path.contains("/archive?") {
                let phase = if healthy { "ready" } else { "stopped" };
                let status = json!({"phase": phase, "updated": "2026-01-02T00:00:01Z", "detail": "", "pid": 42})
                    .to_string();
                let archive = nemoclaw_docker::archive(&[("status.json", status.as_bytes(), 0o600)]);
                return Some((200, archive.unwrap()));
            } else {
                json!({"ID": "engine", "Architecture": "arm64", "ServerVersion": "28.0", "OSType": "linux"})
            };
            Some((200, serde_json::to_vec(&body).unwrap()))
        })
        .await;
        let state = healthy.clone();
        let server = Fixture::start_tcp(move |request| {
            assert_eq!(request.method, "GET");
            let healthy = state.load(Ordering::SeqCst);
            match request.path.as_str() {
                "/health" => Some((if healthy { 200 } else { 503 }, Vec::new())),
                "/v1/models" => {
                    let models = if healthy {
                        json!([{"id": "qwen"}])
                    } else {
                        json!([])
                    };
                    Some((
                        200,
                        json!({"object": "list", "data": models})
                            .to_string()
                            .into_bytes(),
                    ))
                }
                other => panic!("unexpected request {other}"),
            }
        })
        .await;
        // An engine nothing serves: a missing socket, or a closed loopback
        // port where the relay reaches engines.
        let unreachable = if cfg!(unix) {
            "unix:///nonexistent/engine.sock"
        } else {
            "ssh://127.0.0.1:1"
        };
        let variables = vec![
            ("TF_VAR_engine", engine.endpoint.clone()),
            ("TF_VAR_unreachable_engine", unreachable.to_owned()),
            ("TF_VAR_health_url", format!("{}/health", server.endpoint)),
            ("TF_VAR_model_server", server.endpoint.clone()),
        ];
        Self {
            healthy,
            _fixtures: [engine, server],
            variables,
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated host fixtures"]
async fn host_checks_pass_for_a_healthy_host() {
    let host = Host::start().await;
    let environment: Vec<(&str, &str)> = host
        .variables
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    crate::native("host", &environment);
}

/// An incompatible image, an unhealthy container, and a server that stops
/// listing its model each fail the plan that reads them; invalid readiness
/// inputs fail before any read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated host fixtures"]
async fn failed_host_checks_stop_the_plan() {
    let host = Host::start().await;
    let workspace = crate::workspace();
    let main = workspace.path().join("main.tf");
    fs::copy(
        std::path::Path::new(crate::CONTRACT).join("host/main.tf"),
        &main,
    )
    .unwrap();
    let plan = |variables: &[&str]| {
        let output = workspace
            .command()
            .args(["plan", "-input=false", "-no-color"])
            .args(variables)
            .envs(host.variables.clone())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{variables:?} passed");
        // OpenTofu wraps diagnostic text.
        String::from_utf8_lossy(&output.stderr)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    host.healthy.store(false, Ordering::SeqCst);
    let stderr = plan(&[]);
    let expected = [
        "Image compatibility check failed",
        "Container health observation failed",
        r#"data.host_container_health.application["engine"]"#,
        r#"data.host_container_health.application["http"]"#,
        r#"data.host_container_health.application["status"]"#,
        "qwen",
    ];
    for expected in expected {
        assert!(stderr.contains(expected), "{expected}: {stderr}");
    }
    host.healthy.store(true, Ordering::SeqCst);
    // Endpoint readiness serves unauthenticated servers only.
    let stderr = plan(&["-var=authentication=bearer"]);
    assert!(stderr.contains("unauthenticated"), "{stderr}");
    // Endpoint and container inputs are separate modes.
    let source = fs::read_to_string(&main).unwrap();
    let endpoint = "  sandbox_endpoint     = var.sandbox_endpoint\n";
    assert!(source.contains(endpoint));
    let mixed = source.replace(endpoint, &format!("{endpoint}  name = \"qwen\"\n"));
    fs::write(&main, mixed).unwrap();
    let stderr = plan(&[]);
    assert!(
        stderr.contains("either endpoint or the container inputs"),
        "{stderr}"
    );
}
