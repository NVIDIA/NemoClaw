// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored HCL for a vLLM container whose runtime contract the provider computes.

use nemoclaw_e2e::http_fixture::Fixture;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

const REVISION: &str = "1cfa9a7208912126459214e8b04321603b3df60c";

/// A Docker engine that answers the Docker provider's connection checks only.
async fn engine() -> Fixture {
    Fixture::start(|request| {
        let path = request.path.split('?').next().unwrap();
        let value = match path {
            "/_ping" => return Some((200, b"OK".to_vec())),
            "/version" => json!({"ApiVersion":"1.47", "Version":"27.0.0"}),
            "/info" => json!({"ID":"engine"}),
            _ => panic!("planning reached Docker: {} {path}", request.method),
        };
        Some((200, serde_json::to_vec(&value).unwrap()))
    })
    .await
}

/// An OpenTofu workspace that installs the bundle's providers.
struct Workspace {
    directory: tempfile::TempDir,
    tofu: PathBuf,
}

impl Workspace {
    fn new(engine: &str, runtime: &str) -> Self {
        Self::contract(engine, "vllm_runtime", "NEMOCLAW_RUNTIME_SPEC", runtime)
    }

    /// A container whose `variable` takes the `source` data source's contract.
    fn contract(engine: &str, source: &str, variable: &str, settings: &str) -> Self {
        let bundle =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle path"));
        assert!(bundle.is_absolute());
        let version = nemoclaw_sdk::bundle::Bundle::open(&bundle)
            .unwrap()
            .manifest
            .version;
        let workspace = Self {
            directory: tempfile::tempdir().unwrap(),
            tofu: bundle.join("libexec/tofu"),
        };
        fs::write(
            workspace.directory.path().join("providers.tfrc"),
            format!(
                "provider_installation {{ filesystem_mirror {{ path = {} }} }}\n",
                json!(bundle.join("providers"))
            ),
        )
        .unwrap();
        fs::write(
            workspace.directory.path().join("main.tf"),
            format!(
                r#"terraform {{
  required_providers {{
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw", version = "= {version}" }}
    docker   = {{ source = "registry.opentofu.org/kreuzwerker/docker", version = "= 4.6.0" }}
  }}
}}

provider "nemoclaw" {{}}

provider "docker" {{
  host = "{engine}"
}}

data "nemoclaw_{source}" "qwen" {{
{settings}}}

resource "docker_container" "qwen" {{
  name       = "qwen"
  image      = "runtime@sha256:{digest}"
  env        = ["{variable}=${{data.nemoclaw_{source}.qwen.spec}}"]
}}
"#,
                digest = "a".repeat(64),
            ),
        )
        .unwrap();
        let init = workspace.run(&["init", "-input=false", "-no-color"]);
        assert!(
            init.status.success(),
            "{}",
            String::from_utf8_lossy(&init.stderr)
        );
        workspace
    }

    fn run(&self, args: &[&str]) -> std::process::Output {
        std::process::Command::new(&self.tofu)
            .args(args)
            .current_dir(self.directory.path())
            .env(
                "TF_CLI_CONFIG_FILE",
                self.directory.path().join("providers.tfrc"),
            )
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap()
    }

    fn plan(&self) -> std::process::Output {
        self.run(&["plan", "-input=false", "-no-color", "-out=runtime.plan"])
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE; no live services"]
async fn authored_vllm_container_takes_its_runtime_contract_from_typed_settings() {
    let engine = engine().await;
    let workspace = Workspace::new(
        &engine.endpoint,
        &format!(
            r#"  hardware {{
    profile = "dgx-spark"
  }}
  model {{
    repository = "Qwen/Qwen3-4B"
    revision   = "{REVISION}"
  }}
  serving {{
    port             = 18898
    model_name       = "qwen"
    reasoning_parser = "qwen3"
  }}
  memory {{
    gpu_memory_gib = 20
  }}
"#
        ),
    );
    let output = workspace.plan();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let shown = workspace.run(&["show", "-json", "runtime.plan"]);
    let plan: Value = serde_json::from_slice(&shown.stdout).unwrap();
    let container = plan["resource_changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["address"] == "docker_container.qwen")
        .unwrap();
    let environment = container["change"]["after"]["env"][0].as_str().unwrap();
    let encoded = environment
        .strip_prefix("NEMOCLAW_RUNTIME_SPEC=")
        .expect("the planned container carries the runtime contract");
    nemoclaw_runtime::RuntimeSpec::decode(encoded).expect("the runtime accepts the contract");
    let spec: Value = serde_json::from_str(encoded).unwrap();
    assert_eq!(spec["kind"], "vllm");
    assert_eq!(spec["model"]["repository"], "Qwen/Qwen3-4B");
    assert_eq!(spec["serving"]["modelName"], "qwen");
    assert_eq!(spec["serving"]["port"], 18898);
    assert_eq!(spec["memory"]["gpuMemoryGiB"], 20);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE; no live services"]
async fn vllm_runtime_rejects_unknown_and_invalid_settings_at_their_attributes() {
    let engine = engine().await;
    for (runtime, expected) in [
        (
            format!(
                "  hardware {{ profile = \"dgx-spark\" }}\n  model {{\n    repository = \"Qwen/Qwen3-4B\"\n    revision   = \"{REVISION}\"\n  }}\n  serving {{ prot = 18898 }}\n"
            ),
            "prot",
        ),
        (
            format!(
                "  hardware {{ profile = \"dgx-spark\" }}\n  model {{\n    repository = \"Qwen/Qwen3-4B\"\n    revision   = \"{REVISION}\"\n  }}\n  serving {{ port = 80 }}\n"
            ),
            "serving.port",
        ),
    ] {
        let workspace = Workspace::new(&engine.endpoint, &runtime);
        let output = workspace.plan();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{runtime}");
        assert!(stderr.contains(expected), "{expected}: {stderr}");
    }
}

/// The planned container's contract in `variable`.
fn planned_contract(workspace: &Workspace, variable: &str) -> Value {
    let output = workspace.plan();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let plan: Value =
        serde_json::from_slice(&workspace.run(&["show", "-json", "runtime.plan"]).stdout).unwrap();
    let container = plan["resource_changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["address"] == "docker_container.qwen")
        .unwrap();
    let environment = container["change"]["after"]["env"][0].as_str().unwrap();
    serde_json::from_str(
        environment
            .strip_prefix(&format!("{variable}="))
            .expect("the planned container carries the contract"),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_BUNDLE; no live services"]
async fn authored_ollama_containers_take_their_contracts_from_typed_settings() {
    let engine = engine().await;
    let digest = "7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435";
    let workspace = Workspace::contract(
        &engine.endpoint,
        "ollama_runtime",
        "NEMOCLAW_RUNTIME_SPEC",
        &format!(
            r#"  hardware {{
    profile = "dgx-spark"
  }}
  model {{
    name   = "qwen3:0.6b"
    digest = "{digest}"
  }}
  serving {{
    context_tokens = 8192
  }}
"#
        ),
    );
    let spec = planned_contract(&workspace, "NEMOCLAW_RUNTIME_SPEC");
    nemoclaw_runtime::RuntimeSpec::decode(&spec.to_string()).expect("the runtime accepts it");
    assert_eq!(spec["kind"], "ollama");
    assert_eq!(spec["model"]["name"], "qwen3:0.6b");

    let workspace = Workspace::contract(
        &engine.endpoint,
        "ollama_proxy_runtime",
        "NEMOCLAW_OLLAMA_PROXY",
        &format!(
            r#"  bind_address = "127.0.0.1:11435"
  upstream     = "http://127.0.0.1:11434/v1"
  model        = "qwen3:0.6b"
  digest       = "{digest}"
"#
        ),
    );
    let spec = planned_contract(&workspace, "NEMOCLAW_OLLAMA_PROXY");
    assert_eq!(
        spec,
        json!({"upstream": "http://127.0.0.1:11434/v1", "endpoint": "http://127.0.0.1:11435/v1", "model": "qwen3:0.6b", "digest": digest})
    );
}
