// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored container health checks through pinned OpenTofu.

use crate::http_fixture::Fixture;
use serde_json::{Value, json};
use std::{
    fs,
    sync::{Arc, Mutex},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn authored_health_check_reads_an_owned_container_and_rejects_an_unhealthy_one() {
    let health = Arc::new(Mutex::new("healthy"));
    let observed = health.clone();
    let engine = Fixture::engine(move |request| {
        assert_eq!(request.method, "GET", "a health check must not mutate");
        let body: Value = if request.path == "/containers/application-id/json" {
            json!({"Id":"application-id","Name":"/application",
                "Config":{"Labels":{"nemoclaw.nvidia.com/owner":"deployment"}},
                "State":{"Running":true,"StartedAt":"2026-01-02T00:00:00Z","Health":{"Status":*observed.lock().unwrap()}}})
        } else if request.path.contains("/archive?") {
            let status = json!({"phase": if *observed.lock().unwrap() == "healthy" { "ready" } else { "stopped" },
                "updated":"2026-01-02T00:00:01Z","detail":"","pid":42}).to_string();
            return Some((200, nemoclaw_docker::archive(&[("status.json", status.as_bytes(), 0o600)]).unwrap()));
        } else {
            json!({"ID":"engine"})
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    })
    .await;
    let http_health = health.clone();
    let http = Fixture::start_tcp(move |request| {
        assert_eq!(
            (request.method.as_str(), request.path.as_str()),
            ("GET", "/health")
        );
        Some((
            if *http_health.lock().unwrap() == "healthy" {
                200
            } else {
                503
            },
            Vec::new(),
        ))
    })
    .await;
    for mode in [
        String::new(),
        format!("http_url = \"{}/health\"", http.endpoint),
        "runtime_status = \"/data/status.json\"".into(),
    ] {
        *health.lock().unwrap() = "healthy";
        let workspace = crate::workspace();
        fs::write(
            workspace.path().join("main.tf"),
            format!(
                r#"terraform {{
  required_providers {{
    host = {{ source = "registry.opentofu.org/nvidia/host" }}
  }}
}}

provider "host" {{}}

data "host_container_health" "application" {{
  engine       = "{engine}"
  name         = "application"
  container_id = "application-id"
  {mode}
  labels = {{
    "nemoclaw.nvidia.com/owner" = "deployment"
  }}
}}

output "healthy" {{
  value = data.host_container_health.application.healthy
}}
"#,
                engine = engine.endpoint,
            ),
        )
        .unwrap();
        let run = |args: &[&str]| workspace.command().args(args).output().unwrap();
        let output = run(&["apply", "-input=false", "-auto-approve", "-no-color"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let outputs: Value = serde_json::from_slice(&run(&["output", "-json"]).stdout).unwrap();
        assert_eq!(outputs["healthy"]["value"], true);

        *health.lock().unwrap() = "unhealthy";
        let output = run(&["plan", "-input=false", "-no-color"]);
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("Container health observation failed"),
            "{stderr}"
        );
    }
}
