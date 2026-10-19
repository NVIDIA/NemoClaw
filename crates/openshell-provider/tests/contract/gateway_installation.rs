// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Gateway installation types through pinned OpenTofu: the Podman gateway's
//! prerequisite checks and the Docker gateway launch.

use crate::tofu::TofuWorkspace;
use serde_json::{Value, json};
use std::{fs, process::Output};

/// A workspace with the openshell provider under test.
struct Installation {
    dir: TofuWorkspace,
}

impl Installation {
    fn new() -> Self {
        Self {
            dir: crate::workspace(),
        }
    }
    fn run(&self, args: &[&str]) -> Output {
        self.dir.command().args(args).output().unwrap()
    }
    fn success(&self, args: &[&str]) -> Output {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    }
    /// Declare `body` beside the openshell provider.
    fn configure(&self, body: &str) {
        fs::write(
            self.dir.path().join("main.tf"),
            format!(
                r#"terraform {{
  required_providers {{
    openshell = {{ source = "registry.opentofu.org/nvidia/openshell" }}
  }}
}}
provider "openshell" {{}}
{body}"#
            ),
        )
        .unwrap();
    }
}

// A managed gateway needs a local engine, which only Unix clients reach.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn podman_gateway_rechecks_network_and_image_prerequisites_before_saved_plan_apply() {
    use nemoclaw_sdk::{compile, config::Document};
    use std::sync::{Arc, Mutex};

    let mode = Arc::new(Mutex::new("normal"));
    let shared = mode.clone();
    let fixture = crate::http_fixture::Fixture::engine(move |request| {
        assert_eq!(request.method, "GET", "planning or rejected apply mutated Docker");
        let mode = *shared.lock().unwrap();
        let response = match request.path.split('?').next().unwrap() {
            "/info" => (200, json!({"ID":"engine", "Architecture":"x86_64"})),
            "/networks" => (200, if mode == "overlap" {
                json!([{"IPAM":{"Config":[{"Subnet":"172.30.121.0/24"}]}}])
            } else { json!([]) }),
            path if path.starts_with("/networks/") => (404, json!({})),
            path if path.starts_with("/containers/") => (404, json!({})),
            path if path.starts_with("/images/") => {
                if mode == "missing-image" {
                    (404, json!({}))
                } else {
                    (200, json!({"Id":"sha256:gateway", "Os":"linux", "Architecture":if mode == "wrong-architecture" { "arm64" } else { "amd64" }}))
                }
            }
            _ => panic!("unexpected prerequisite observation {}", request.path),
        };
        Some((response.0, serde_json::to_vec(&response.1).unwrap()))
    }).await;
    let e = Installation::new();
    let document =
        Document::parse(include_bytes!("../../../../examples/spark/vllm.yaml").as_slice()).unwrap();
    let generations = [
        ("managed_gateway".into(), "a".repeat(32)),
        ("inference_service".into(), "b".repeat(32)),
    ]
    .into();
    let target = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "managed_gateway")
        .unwrap();
    // Planning checks prerequisites only for known identity; omitted identity
    // is generated during apply.
    let mut settings = target.values.clone();
    settings.remove("image_pull_policy");
    settings.insert("engine".into(), fixture.endpoint.clone());
    let configure = |policy: &str| {
        let attributes: String = settings
            .iter()
            .chain([(&"image_pull_policy".to_owned(), &policy.to_owned())])
            .map(|(name, value)| format!("  {name} = {}\n", json!(value)))
            .collect();
        fs::write(
            e.dir.path().join("main.tf"),
            format!(
                r#"terraform {{
  required_providers {{
    openshell = {{ source = "registry.opentofu.org/nvidia/openshell" }}
  }}
}}
provider "openshell" {{}}
resource "openshell_podman_gateway" "gateway" {{
{attributes}}}
"#
            ),
        )
        .unwrap();
    };
    configure("Never");
    e.success(&["validate"]);
    for (failure, expected) in [
        ("overlap", "subnet overlaps"),
        (
            "wrong-architecture",
            "incompatible with the execution target",
        ),
        ("missing-image", "image is absent"),
    ] {
        *mode.lock().unwrap() = failure;
        let output = e.run(&["plan", "-input=false"]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        *mode.lock().unwrap() = "normal";
        e.success(&["plan", "-input=false", "-out=prerequisites.plan"]);
        *mode.lock().unwrap() = failure;
        let output = e.run(&["apply", "-input=false", "prerequisites.plan"]);
        assert!(!output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    for policy in ["Always", "IfNotPresent"] {
        configure(policy);
        *mode.lock().unwrap() = "missing-image";
        e.success(&["plan", "-input=false"]);
    }
}

/// Whether an engine can host a gateway with each compute driver: a Docker
/// engine serves the Docker driver but not the Podman one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn gateway_prerequisites_report_whether_an_engine_can_host_a_gateway() {
    let fixture = crate::http_fixture::Fixture::engine(|request| {
        assert_eq!(request.method, "GET", "a prerequisite read mutated the engine");
        let path = request.path.split('?').next().unwrap();
        let body = if path.ends_with("/libpod/info") {
            json!({"host":{"security":{"rootless":false}}})
        } else if path.ends_with("/version") {
            json!({"Version":"28.0", "ApiVersion":"1.47", "Components":[{"Name":"Engine", "Version":"28.0"}]})
        } else if path.ends_with("/info") {
            json!({"ID":"engine"})
        } else {
            panic!("unexpected engine query {path}")
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    })
    .await;
    let e = Installation::new();
    e.configure(&format!(
        r#"data "openshell_gateway_prerequisites" "docker" {{
  engine         = "{engine}"
  compute_driver = "docker"
}}
data "openshell_gateway_prerequisites" "podman" {{
  engine         = "{engine}"
  compute_driver = "podman"
}}
output "docker" {{
  value = data.openshell_gateway_prerequisites.docker.status
}}
output "podman" {{
  value = data.openshell_gateway_prerequisites.podman.observation_json
}}
"#,
        engine = fixture.endpoint
    ));
    e.success(&[
        "plan",
        "-input=false",
        "-no-color",
        "-out=prerequisites.plan",
    ]);
    let plan: Value =
        serde_json::from_slice(&e.success(&["show", "-json", "prerequisites.plan"]).stdout)
            .unwrap();
    let outputs = &plan["planned_values"]["outputs"];
    assert_eq!(outputs["docker"]["value"], "available");
    let podman: Value = serde_json::from_str(outputs["podman"]["value"].as_str().unwrap()).unwrap();
    assert_eq!(podman["status"], "unavailable");
    assert_eq!(
        podman["reason"],
        "Podman sandbox driver requires a Podman engine socket"
    );
}

#[test]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; no live services"]
fn docker_gateway_launch_comes_from_typed_settings() {
    let e = Installation::new();
    let data = "/var/lib/docker/volumes/nc-0123456789abcdef-gateway-data/_data";
    e.configure(&format!(
        r#"data "openshell_docker_gateway_runtime" "gateway" {{
  name      = "nc-0123456789abcdef-gateway"
  endpoint  = "http://127.0.0.1:17670"
  data_path = "{data}"
}}
output "entrypoint" {{
  value = data.openshell_docker_gateway_runtime.gateway.entrypoint
}}
output "command" {{
  value = data.openshell_docker_gateway_runtime.gateway.command
}}
output "env" {{
  value = data.openshell_docker_gateway_runtime.gateway.env
}}
"#
    ));
    // The launch is computed without contacting any host, so it is known
    // while planning.
    e.success(&["plan", "-input=false", "-no-color", "-out=runtime.plan"]);
    let plan: Value =
        serde_json::from_slice(&e.success(&["show", "-json", "runtime.plan"]).stdout).unwrap();
    let outputs = &plan["planned_values"]["outputs"];
    assert_eq!(
        outputs["entrypoint"]["value"],
        json!(["/usr/local/bin/openshell-gateway"])
    );
    assert_eq!(
        outputs["command"]["value"],
        json!([
            "--config",
            format!("{data}/gateway.toml"),
            "--name",
            "nc-0123456789abcdef-gateway",
            "--bind-address",
            "0.0.0.0",
            "--port",
            "17670"
        ])
    );
    let mut environment: Vec<_> = outputs["env"]["value"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    environment.sort();
    assert_eq!(
        environment,
        [
            format!("OPENSHELL_DB_URL=sqlite:{data}/gateway.db"),
            format!("XDG_STATE_HOME={data}/state"),
        ]
    );

    e.configure(
        r#"data "openshell_docker_gateway_runtime" "gateway" {
  name      = "nc-0123456789abcdef-gateway"
  endpoint  = "http://127.0.0.1:80"
  data_path = "relative"
}
"#,
    );
    let output = e.run(&["plan", "-input=false", "-no-color"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Invalid Docker gateway settings"),
        "{stderr}"
    );
}
