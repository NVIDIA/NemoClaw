// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Gateway installation types through pinned OpenTofu: the Podman gateway's
//! prerequisite checks before a saved plan applies, and the settings in
//! `gateway/main.tf`.

use crate::tofu::TofuWorkspace;
use serde_json::json;
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

/// A Docker engine that answers reads only.
async fn docker_engine() -> crate::http_fixture::Fixture {
    crate::http_fixture::Fixture::engine(|request| {
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
    .await
}

/// `gateway/tests`: the Docker gateway launch, engine prerequisites, and the
/// Kubernetes resources plan from typed settings.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn gateway_settings_plan_without_contacting_a_host() {
    let engine = docker_engine().await;
    crate::native("gateway", &[("TF_VAR_engine", &engine.endpoint)]).await;
}

/// Invalid settings in `gateway/main.tf` fail planning at each resource.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn invalid_gateway_settings_are_rejected_at_their_resources() {
    let engine = docker_engine().await;
    let e = Installation::new();
    fs::copy(
        std::path::Path::new(crate::CONTRACT).join("gateway/main.tf"),
        e.dir.path().join("main.tf"),
    )
    .unwrap();
    let plan = |variables: &[&str]| {
        let output = e.run(
            &[
                ["plan", "-input=false", "-no-color"].as_slice(),
                &[&format!("-var=engine={}", engine.endpoint)],
                variables,
            ]
            .concat(),
        );
        assert!(!output.status.success(), "{variables:?} was accepted");
        String::from_utf8_lossy(&output.stderr).into_owned()
    };
    let stderr = plan(&[
        "-var=gateway_endpoint=http://127.0.0.1:80",
        "-var=data_path=relative",
    ]);
    assert!(
        stderr.contains("Invalid Docker gateway settings"),
        "{stderr}"
    );
    // The Kubernetes types share their attribute checks. OpenTofu skips the
    // resources that take the storage's owner once its validation fails.
    let stderr = plan(&["-var=namespace=Not A Namespace"]);
    assert!(
        stderr.contains("openshell_kubernetes_storage.platform"),
        "{stderr}"
    );
    assert!(
        stderr.contains("namespace must be a Kubernetes namespace name"),
        "{stderr}"
    );
}
