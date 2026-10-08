// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored HCL for retained service storage through pinned OpenTofu.

use nemoclaw_e2e::{http_fixture::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

const OWNER: &str = "302ff5e1-088d-42ce-959f-4ff4c3570c13";

/// A Docker engine that stores named volumes and counts creations.
async fn volume_engine() -> (Fixture, Arc<Mutex<(BTreeMap<String, Value>, usize)>>) {
    let volumes = Arc::new(Mutex::new((BTreeMap::new(), 0)));
    let shared = volumes.clone();
    let fixture = Fixture::start(move |request| {
        let mut volumes = shared.lock().unwrap();
        let path = request.path.split('?').next().unwrap();
        let (status, value) = match (request.method.as_str(), path) {
            ("GET", "/info") => (200, json!({"ID":"engine"})),
            ("POST", "/volumes/create") => {
                let request: Value = serde_json::from_slice(&request.body).unwrap();
                let name = request["Name"].as_str().unwrap().to_owned();
                let volume = json!({"Name":name, "Driver":"local", "Mountpoint":"/fixture", "CreatedAt":"2026-10-08T00:00:00Z", "Labels":request["Labels"], "Options":{}, "Scope":"local"});
                volumes.0.insert(name, volume.clone());
                volumes.1 += 1;
                (201, volume)
            }
            ("GET", path) if path.starts_with("/volumes/") => {
                match volumes.0.get(path.trim_start_matches("/volumes/")) {
                    Some(volume) => (200, volume.clone()),
                    None => (404, json!({"message":"missing"})),
                }
            }
            _ => panic!("unexpected Docker operation {} {path}", request.method),
        };
        Some((status, serde_json::to_vec(&value).unwrap()))
    })
    .await;
    (fixture, volumes)
}

fn workspace() -> TofuWorkspace {
    let path = |name| PathBuf::from(std::env::var_os(name).expect("explicit qualification path"));
    let (tofu, provider) = (path("NEMOCLAW_TEST_TOFU"), path("NEMOCLAW_TEST_PROVIDER"));
    assert!(tofu.is_absolute() && provider.is_absolute());
    TofuWorkspace::new(tofu, provider)
}

fn configure(workspace: &TofuWorkspace, kind: &str, name: &str, owner: &str, engine: &str) {
    fs::write(
        workspace.path().join("main.tf"),
        format!(
            r#"terraform {{
  required_providers {{
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw" }}
  }}
}}

provider "nemoclaw" {{
  endpoint = "http://127.0.0.1:1"
}}

resource "{kind}" "credentials" {{
  name       = "{name}"
  owner      = "{owner}"
  generation = "{generation}"
  engine     = "{engine}"
}}
"#,
            generation = "b".repeat(32),
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

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Docker fixture"]
async fn authored_service_storage_applies_refreshes_and_names_invalid_attributes() {
    for (kind, name) in [
        (
            "nemoclaw_inference_storage",
            "nc-0123456789abcdef-inference-qwen-auth",
        ),
        (
            "nemoclaw_ollama_service_storage",
            "nc-0123456789abcdef-ollama-local-auth",
        ),
    ] {
        let (engine, volumes) = volume_engine().await;
        let workspace = workspace();
        configure(&workspace, kind, name, "not-an-owner", &engine.endpoint);
        let output = run(&workspace, &["plan", "-input=false", "-no-color"]);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{kind}: {stderr}");
        assert!(
            stderr.contains("Error: Invalid owner")
                && stderr.contains("owner      = \"not-an-owner\"")
                && stderr.contains("owner must be a lowercase UUID"),
            "{kind}: the diagnostic must point at the owner attribute: {stderr}"
        );
        assert_eq!(volumes.lock().unwrap().1, 0, "{kind}");

        configure(&workspace, kind, name, OWNER, &engine.endpoint);
        success(
            &workspace,
            &["apply", "-input=false", "-auto-approve", "-no-color"],
        );
        let volume = volumes.lock().unwrap().0[name].clone();
        assert_eq!(volume["Labels"]["nemoclaw.nvidia.com/uid"], OWNER, "{kind}");
        let state: Value =
            serde_json::from_slice(&success(&workspace, &["show", "-json"]).stdout).unwrap();
        let attributes = &state["values"]["root_module"]["resources"][0]["values"];
        assert_eq!(attributes["name"], name, "{kind}");
        assert_eq!(attributes["owner"], OWNER, "{kind}");
        assert_eq!(
            attributes["id"],
            format!("engine/{name}/2026-10-08T00:00:00Z"),
            "{kind}"
        );
        let output = run(
            &workspace,
            &["plan", "-input=false", "-no-color", "-detailed-exitcode"],
        );
        assert_eq!(
            output.status.code(),
            Some(0),
            "{kind}: refresh must find no changes: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(volumes.lock().unwrap().1, 1, "{kind}");
    }
}
