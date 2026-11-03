// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Retained service storage that must fail planning or applying, which `tofu
//! test` cannot expect. `hcl/storage/tests` covers its identity.

use crate::{http_fixture::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    fs,
    sync::{Arc, Mutex},
};

const OWNER: &str = "302ff5e1-088d-42ce-959f-4ff4c3570c13";
const KINDS: [&str; 1] = ["vllm_credential_storage"];

use crate::fakes::volume_engine;

fn workspace() -> TofuWorkspace {
    crate::workspace()
}

/// Write one storage resource; `identity` supplies owner and generation.
fn configure(
    workspace: &TofuWorkspace,
    kind: &str,
    name: &str,
    identity: Option<(&str, &str)>,
    engine: &str,
) {
    let identity = identity.map_or_else(String::new, |(owner, generation)| {
        format!("  owner      = \"{owner}\"\n  generation = \"{generation}\"\n")
    });
    fs::write(
        workspace.path().join("main.tf"),
        format!(
            r#"terraform {{
  required_providers {{
    vllm     = {{ source = "registry.opentofu.org/nvidia/vllm" }}
    ollama   = {{ source = "registry.opentofu.org/nvidia/ollama" }}
  }}
}}

provider "vllm" {{}}
provider "ollama" {{}}

resource "{kind}" "credentials" {{
  name       = "{name}"
{identity}  engine     = "{engine}"
}}
"#
        ),
    )
    .unwrap();
}

fn run(workspace: &TofuWorkspace, args: &[&str]) -> std::process::Output {
    workspace.command().args(args).output().unwrap()
}

fn success(workspace: &TofuWorkspace, args: &[&str]) -> std::process::Output {
    let output = run(workspace, args);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

/// An invalid owner fails planning at its attribute, before any volume.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn invalid_storage_identity_is_rejected_at_its_attribute() {
    let (engine, volumes) = volume_engine().await;
    let workspace = workspace();
    configure(
        &workspace,
        "vllm_credential_storage",
        "nc-0123456789abcdef-inference-qwen-auth",
        Some(("not-an-owner", &"b".repeat(32))),
        &engine.endpoint,
    );
    let output = run(&workspace, &["plan", "-input=false", "-no-color"]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "{stderr}");
    assert!(
        stderr.contains("Error: Invalid owner")
            && stderr.contains("owner      = \"not-an-owner\"")
            && stderr.contains("owner must be a lowercase UUID"),
        "the diagnostic must point at the owner attribute: {stderr}"
    );
    assert_eq!(volumes.lock().unwrap().creates, 0);
}

// Retained storage is never recreated: refresh refuses a volume that is
// missing, labeled for another owner, or replaced under the same name, and
// leaves the saved binding unchanged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn missing_foreign_or_substituted_storage_stops_plan_and_apply_without_changing_state() {
    for kind in KINDS {
        let (engine, volumes) = volume_engine().await;
        let workspace = workspace();
        let name = "retained-credentials";
        configure(
            &workspace,
            kind,
            name,
            Some((OWNER, &"b".repeat(32))),
            &engine.endpoint,
        );
        success(
            &workspace,
            &["apply", "-input=false", "-auto-approve", "-no-color"],
        );
        // Intact storage plans no changes; each fault below must stop that plan.
        success(
            &workspace,
            &["plan", "-input=false", "-no-color", "-detailed-exitcode"],
        );
        let state = fs::read(workspace.path().join("terraform.tfstate")).unwrap();
        let retained = volumes.lock().unwrap().volumes[name].clone();
        for fault in ["missing", "foreign", "substituted"] {
            let mut damaged = retained.clone();
            match fault {
                "missing" => {
                    volumes.lock().unwrap().volumes.remove(name);
                }
                "foreign" => {
                    damaged["Labels"]["nemoclaw.nvidia.com/uid"] =
                        json!("ffffffff-ffff-ffff-ffff-ffffffffffff");
                }
                _ => damaged["CreatedAt"] = json!("2026-10-09T00:00:00Z"),
            }
            let reason = if fault == "missing" {
                "bound persistent storage is absent; recreation forbidden"
            } else {
                "observed ownership, generation, or durable identity changed"
            };
            if fault != "missing" {
                volumes
                    .lock()
                    .unwrap()
                    .volumes
                    .insert(name.into(), damaged.clone());
            }
            for args in [
                &["plan", "-input=false", "-no-color"][..],
                &["apply", "-input=false", "-auto-approve", "-no-color"],
            ] {
                let output = run(&workspace, args);
                let stderr = String::from_utf8_lossy(&output.stderr);
                assert!(
                    !output.status.success() && stderr.contains(reason),
                    "{kind} {fault}: {} must fail with {reason:?}: {stderr}",
                    args[0]
                );
                assert_eq!(
                    fs::read(workspace.path().join("terraform.tfstate")).unwrap(),
                    state,
                    "{kind} {fault}: {} changed the state",
                    args[0]
                );
            }
            let current = volumes.lock().unwrap().volumes.get(name).cloned();
            assert_eq!(
                current,
                (fault != "missing").then_some(damaged),
                "{kind} {fault}"
            );
            assert_eq!(volumes.lock().unwrap().creates, 1, "{kind} {fault}");
            volumes
                .lock()
                .unwrap()
                .volumes
                .insert(name.into(), retained.clone());
        }
    }
}

fn state_attributes(workspace: &TofuWorkspace) -> Value {
    let state: Value =
        serde_json::from_slice(&success(workspace, &["show", "-json"]).stdout).unwrap();
    state["values"]["root_module"]["resources"][0]["values"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn lost_reply_with_omitted_identity_stops_until_its_identity_is_supplied() {
    for kind in KINDS {
        let (engine, volumes) = volume_engine().await;
        volumes.lock().unwrap().lose_create = true;
        let workspace = workspace();
        configure(
            &workspace,
            kind,
            "authored-credentials",
            None,
            &engine.endpoint,
        );
        let apply = ["apply", "-input=false", "-auto-approve", "-no-color"];
        assert!(!run(&workspace, &apply).status.success(), "{kind}");
        let labels = volumes.lock().unwrap().volumes["authored-credentials"]["Labels"].clone();

        // The reply that carried the generated identity is gone, so the
        // next apply generates another and must refuse the existing volume.
        let output = run(&workspace, &apply);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{kind}");
        assert!(
            stderr.contains("observed ownership, generation, or durable identity changed"),
            "{kind}: {stderr}"
        );
        assert_eq!(volumes.lock().unwrap().creates, 1, "{kind}");

        configure(
            &workspace,
            kind,
            "authored-credentials",
            Some((
                labels["nemoclaw.nvidia.com/uid"].as_str().unwrap(),
                labels["nemoclaw.nvidia.com/generation"].as_str().unwrap(),
            )),
            &engine.endpoint,
        );
        success(&workspace, &apply);
        assert_eq!(
            state_attributes(&workspace)["owner"],
            labels["nemoclaw.nvidia.com/uid"],
            "{kind}"
        );
        assert_eq!(volumes.lock().unwrap().creates, 1, "{kind}");
    }
}

/// An Ollama upstream that lists one model with the digest it holds.
async fn upstream(digest: Arc<Mutex<String>>) -> Fixture {
    Fixture::start_tcp(move |request| {
        if request.method != "GET" || request.path != "/api/tags" {
            return Some((400, Vec::new()));
        }
        let body =
            json!({"models":[{"name":"qwen3:0.6b","digest":*digest.lock().unwrap(),"size":42}]});
        Some((200, body.to_string().into_bytes()))
    })
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Ollama fixture"]
async fn ollama_model_checks_its_digest_while_planning() {
    let digest = Arc::new(Mutex::new("a".repeat(64)));
    let upstream = upstream(digest.clone()).await;
    let workspace = workspace();
    let configure = |upstream: &str, name: &str| {
        fs::write(
            workspace.path().join("main.tf"),
            format!(
                r#"terraform {{
  required_providers {{
    ollama = {{ source = "registry.opentofu.org/nvidia/ollama" }}
  }}
}}

provider "ollama" {{}}

data "ollama_model" "local" {{
  upstream = "{upstream}/v1"
  name     = "{name}"
  digest   = "{digest}"
}}

output "model" {{
  value = data.ollama_model.local.ref
}}
"#,
                digest = "a".repeat(64),
            ),
        )
        .unwrap();
    };
    configure(&upstream.endpoint, "qwen3:0.6b");
    success(
        &workspace,
        &["apply", "-input=false", "-auto-approve", "-no-color"],
    );
    let output = success(&workspace, &["output", "-json", "model"]);
    let model: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        model,
        json!({
            "type": "ollama_model",
            "upstream": format!("{}/v1", upstream.endpoint),
            "name": "qwen3:0.6b",
            "digest": "a".repeat(64),
        })
    );
    success(
        &workspace,
        &["plan", "-input=false", "-no-color", "-detailed-exitcode"],
    );
    // A changed upstream digest stops planning and names the model.
    *digest.lock().unwrap() = "b".repeat(64);
    let output = run(&workspace, &["plan", "-input=false", "-no-color"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("qwen3:0.6b"), "{stderr}");
    assert!(stderr.contains("digest changed"), "{stderr}");
    // An absent model is an error, never an install.
    *digest.lock().unwrap() = "a".repeat(64);
    configure(&upstream.endpoint, "absent:latest");
    let output = run(&workspace, &["plan", "-input=false", "-no-color"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("absent"), "{stderr}");
    // Only local upstreams are read; others fail validation.
    configure("http://192.0.2.1:11434", "qwen3:0.6b");
    let output = run(&workspace, &["validate", "-no-color"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("loopback"), "{stderr}");
}
