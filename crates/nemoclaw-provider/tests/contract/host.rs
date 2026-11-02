// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Host checks in `host/main.tf` against a fake engine, a health endpoint,
//! and a model server. `host/tests` covers passing checks; failed reads fail
//! the plan, which `tofu test` cannot expect.

use crate::http_fixture::Fixture;
use serde_json::json;
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

/// The fixtures, which pass every check while `healthy` holds.
struct Host {
    healthy: Arc<AtomicBool>,
    engine: Fixture,
    health: Fixture,
    models: Fixture,
}

impl Host {
    async fn start() -> Self {
        let healthy = Arc::new(AtomicBool::new(true));
        let state = healthy.clone();
        let engine = Fixture::engine(move |request| {
            assert_eq!(request.method, "GET", "a host check must not mutate");
            let healthy = state.load(Ordering::SeqCst);
            let body = if request.path.starts_with("/images/") {
                json!({"Id": "sha256:runtime", "Os": "linux", "Architecture": "arm64",
                    "Config": {"Labels": {"org.nemoclaw.backend": if healthy { "vllm" } else { "ollama" }}}})
            } else if request.path == "/containers/application-id/json" {
                json!({"Id":"application-id","Name":"/application",
                    "Config":{"Labels":{"nemoclaw.nvidia.com/owner":"deployment"}},
                    "State":{"Running":true,"StartedAt":"2026-01-02T00:00:00Z",
                        "Health":{"Status": if healthy { "healthy" } else { "unhealthy" }}}})
            } else if request.path.contains("/archive?") {
                let status = json!({"phase": if healthy { "ready" } else { "stopped" },
                    "updated":"2026-01-02T00:00:01Z","detail":"","pid":42}).to_string();
                return Some((200, nemoclaw_docker::archive(&[("status.json", status.as_bytes(), 0o600)]).unwrap()));
            } else {
                json!({"ID":"engine", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"})
            };
            Some((200, serde_json::to_vec(&body).unwrap()))
        })
        .await;
        let state = healthy.clone();
        let health = Fixture::start_tcp(move |request| {
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("GET", "/health")
            );
            Some((
                if state.load(Ordering::SeqCst) {
                    200
                } else {
                    503
                },
                Vec::new(),
            ))
        })
        .await;
        let state = healthy.clone();
        let models = Fixture::start_tcp(move |request| {
            if request.method != "GET" || request.path != "/v1/models" {
                return Some((404, Vec::new()));
            }
            let models = if state.load(Ordering::SeqCst) {
                json!([{"id": "qwen", "object": "model"}])
            } else {
                json!([])
            };
            Some((
                200,
                json!({"object": "list", "data": models})
                    .to_string()
                    .into_bytes(),
            ))
        })
        .await;
        Self {
            healthy,
            engine,
            health,
            models,
        }
    }

    fn variables(&self) -> Vec<(&'static str, String)> {
        // An engine nothing serves: a missing socket, or a closed loopback
        // port where the relay reaches engines.
        let unreachable = if cfg!(unix) {
            "unix:///nonexistent/engine.sock"
        } else {
            "ssh://127.0.0.1:1"
        };
        vec![
            ("TF_VAR_engine", self.engine.endpoint.clone()),
            ("TF_VAR_unreachable_engine", unreachable.to_owned()),
            (
                "TF_VAR_health_url",
                format!("{}/health", self.health.endpoint),
            ),
            ("TF_VAR_model_server", self.models.endpoint.clone()),
        ]
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated host fixtures"]
async fn host_checks_pass_for_a_healthy_host() {
    let host = Host::start().await;
    let variables = host.variables();
    let environment: Vec<(&str, &str)> = variables
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
    fs::copy(
        std::path::Path::new(crate::CONTRACT).join("host/main.tf"),
        workspace.path().join("main.tf"),
    )
    .unwrap();
    let plan = |variables: &[&str]| {
        let output = workspace
            .command()
            .args(["plan", "-input=false", "-no-color"])
            .args(variables)
            .envs(host.variables())
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
    assert!(
        stderr.contains("Image compatibility check failed"),
        "{stderr}"
    );
    for mode in ["engine", "http", "status"] {
        assert!(
            stderr.contains(&format!(
                "data.host_container_health.application[\"{mode}\"]"
            )),
            "{mode}: {stderr}"
        );
    }
    assert!(
        stderr.contains("Container health observation failed"),
        "{stderr}"
    );
    assert!(stderr.contains("qwen"), "{stderr}");
    host.healthy.store(true, Ordering::SeqCst);
    // Endpoint readiness serves unauthenticated servers only.
    let stderr = plan(&["-var=authentication=bearer"]);
    assert!(stderr.contains("unauthenticated"), "{stderr}");
    // Endpoint and container inputs are separate modes.
    let main = workspace.path().join("main.tf");
    let source = fs::read_to_string(&main).unwrap();
    let endpoint = "  sandbox_endpoint     = var.sandbox_endpoint\n";
    assert!(source.contains(endpoint));
    fs::write(
        &main,
        source.replace(endpoint, &format!("{endpoint}  name = \"qwen\"\n")),
    )
    .unwrap();
    let stderr = plan(&[]);
    assert!(
        stderr.contains("either endpoint or the container inputs"),
        "{stderr}"
    );
}
