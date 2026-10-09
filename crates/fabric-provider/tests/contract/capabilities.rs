// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image capabilities through OpenTofu, read from a fake Docker engine.

use super::*;
use nemoclaw_fabric::catalog::{BridgeCapabilities, FabricCatalog, IMAGE_CATALOG_LABEL};

/// A Docker engine that serves one image declaring the bundled Fabric
/// catalog, and no image for references containing `missing`.
async fn engine(digest: String) -> http::Fixture {
    let mut catalog = FabricCatalog::bundled();
    catalog.bridge = Some(BridgeCapabilities {
        interface_version: 1,
        operations: [
            "validate",
            "prepare",
            "configure",
            "check",
            "invoke",
            "serve",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        health_checks: Vec::new(),
    });
    // One adapter, so the image's runtime declares binaries for all of them.
    catalog
        .adapters
        .retain(|adapter| adapter.adapter_id() == "nvidia.fabric.langchain.deepagents");
    let mut runtime: Value =
        serde_json::from_str(include_str!("../../../../image/fabric/runtime.json")).unwrap();
    runtime["binaries"] = json!({"nvidia.fabric.langchain.deepagents": ["/srv/python3.99"]});
    catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
    let label = serde_json::to_string(&catalog).unwrap();
    http::Fixture::start(move |request| {
        assert_eq!(
            request.method, "GET",
            "capabilities must not change the engine"
        );
        if request.path.contains("missing") {
            return Some((404, br#"{"message":"No such image"}"#.to_vec()));
        }
        let image = json!({"Id": "sha256:config", "Architecture": "arm64", "Os": "linux",
            "RepoDigests": [digest], "Config": {"Labels": {IMAGE_CATALOG_LABEL: label}}});
        Some((200, serde_json::to_vec(&image).unwrap()))
    })
    .await
}

fn configuration(image: &str, architecture: &str, reads: &[&str]) -> String {
    let configuration = json!({
        "schema_version": "fabric.agent/v1alpha1", "metadata": {"name": "main"}, "runtime": {},
        "harness": {"adapter_id": "nvidia.fabric.langchain.deepagents"},
        "models": {"default": {"provider": "openai", "model": "fixture-model",
            "base_url": "http://localhost/v1", "api_key_env": "MODEL_KEY"}}});
    format!(
        r#"terraform {{
  required_version = "= 1.12.6"
  required_providers {{
    fabric = {{ source = "registry.opentofu.org/nvidia/fabric" }}
  }}
}}
variable "engine" {{ type = string }}
provider "fabric" {{}}
data "fabric_capabilities" "agent" {{
  engine            = var.engine
  image             = "{image}"
  architecture      = "{architecture}"
  operating_system  = "linux"
  config_json       = {configuration}
  filesystem_read   = {reads}
}}
output "compatibility" {{ value = data.fabric_capabilities.agent.compatibility_status }}
output "binaries" {{ value = jsondecode(data.fabric_capabilities.agent.binaries_json) }}
output "observation" {{ value = data.fabric_capabilities.agent.observation_json }}
"#,
        configuration = serde_json::to_string(&configuration.to_string()).unwrap(),
        reads = serde_json::to_string(reads).unwrap()
    )
}

/// A compatible image reports its runtime binaries. A different platform, or
/// an explicit read policy that omits the runtime's paths, is unsupported, and
/// a missing image is unknown; none of these fail apply or change the engine.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; fake Docker engine"]
async fn capabilities_judge_the_image_for_the_configuration() {
    let digest = format!("registry/agent@sha256:{}", "a".repeat(64));
    let engine = engine(digest.clone()).await;
    let runtime_reads = ["/opt/fabric", "/opt/nemoclaw", "/sandbox"].as_slice();
    for (image, architecture, reads, expected) in [
        (digest.as_str(), "aarch64", runtime_reads, "supported"),
        (digest.as_str(), "amd64", runtime_reads, "unsupported"),
        (
            digest.as_str(),
            "aarch64",
            ["/sandbox"].as_slice(),
            "unsupported",
        ),
        ("missing:image", "aarch64", runtime_reads, "unknown"),
    ] {
        let workspace = TofuWorkspace::with_providers(tofu(), &[("fabric", &provider("fabric"))]);
        fs::write(
            workspace.path().join("main.tf"),
            configuration(image, architecture, reads),
        )
        .unwrap();
        let output = workspace
            .command()
            .args([
                "apply",
                "-auto-approve",
                "-input=false",
                "-no-color",
                "-var",
            ])
            .arg(format!("engine={}", engine.endpoint))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{image} {architecture}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let outputs: Value = serde_json::from_slice(
            &workspace
                .command()
                .args(["output", "-json"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        assert_eq!(
            outputs["compatibility"]["value"], expected,
            "{image} {architecture}: {}",
            outputs["observation"]["value"]
        );
        let binaries = outputs["binaries"]["value"].as_array().unwrap();
        assert_eq!(
            binaries.is_empty(),
            image.contains("missing"),
            "{binaries:?}"
        );
    }
}
