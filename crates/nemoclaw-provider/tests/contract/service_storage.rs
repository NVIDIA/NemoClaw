// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored HCL for retained service storage through pinned OpenTofu.

use crate::{http_fixture::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    sync::{Arc, Mutex},
};

const OWNER: &str = "302ff5e1-088d-42ce-959f-4ff4c3570c13";
const KINDS: [&str; 2] = [
    "nemoclaw_inference_storage",
    "nemoclaw_ollama_service_storage",
];

#[derive(Default)]
struct Volumes {
    volumes: BTreeMap<String, Value>,
    creates: usize,
    /// Create the next volume but close the connection before replying.
    lose_create: bool,
}

/// A Docker engine that stores named volumes and counts creations.
async fn volume_engine() -> (Fixture, Arc<Mutex<Volumes>>) {
    let volumes = Arc::new(Mutex::new(Volumes::default()));
    let shared = volumes.clone();
    let fixture = Fixture::engine(move |request| {
        let mut volumes = shared.lock().unwrap();
        let path = request.path.split('?').next().unwrap();
        let (status, value) = match (request.method.as_str(), path) {
            ("GET", "/info") => (200, json!({"ID":"engine"})),
            ("POST", "/volumes/create") => {
                let request: Value = serde_json::from_slice(&request.body).unwrap();
                let name = request["Name"].as_str().unwrap().to_owned();
                let volume = json!({"Name":name, "Driver":"local", "Mountpoint":"/fixture", "CreatedAt":"2026-10-08T00:00:00Z", "Labels":request["Labels"], "Options":{}, "Scope":"local"});
                volumes.volumes.insert(name, volume.clone());
                volumes.creates += 1;
                if std::mem::take(&mut volumes.lose_create) {
                    return None;
                }
                (201, volume)
            }
            ("GET", path) if path.starts_with("/volumes/") => {
                match volumes.volumes.get(path.trim_start_matches("/volumes/")) {
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
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw" }}
  }}
}}

provider "nemoclaw" {{}}

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
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
        let generation = "b".repeat(32);
        configure(
            &workspace,
            kind,
            name,
            Some(("not-an-owner", &generation)),
            &engine.endpoint,
        );
        let output = run(&workspace, &["plan", "-input=false", "-no-color"]);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "{kind}: {stderr}");
        assert!(
            stderr.contains("Error: Invalid owner")
                && stderr.contains("owner      = \"not-an-owner\"")
                && stderr.contains("owner must be a lowercase UUID"),
            "{kind}: the diagnostic must point at the owner attribute: {stderr}"
        );
        assert_eq!(volumes.lock().unwrap().creates, 0, "{kind}");

        configure(
            &workspace,
            kind,
            name,
            Some((OWNER, &generation)),
            &engine.endpoint,
        );
        success(
            &workspace,
            &["apply", "-input=false", "-auto-approve", "-no-color"],
        );
        let volume = volumes.lock().unwrap().volumes[name].clone();
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
        assert_eq!(volumes.lock().unwrap().creates, 1, "{kind}");
    }
}

fn state_attributes(workspace: &TofuWorkspace) -> Value {
    let state: Value =
        serde_json::from_slice(&success(workspace, &["show", "-json"]).stdout).unwrap();
    state["values"]["root_module"]["resources"][0]["values"].clone()
}

fn lowercase_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn omitted_storage_identity_is_generated_once_and_kept() {
    for kind in KINDS {
        let (engine, volumes) = volume_engine().await;
        let workspace = workspace();
        configure(
            &workspace,
            kind,
            "authored-credentials",
            None,
            &engine.endpoint,
        );
        success(
            &workspace,
            &["apply", "-input=false", "-auto-approve", "-no-color"],
        );
        let attributes = state_attributes(&workspace);
        let owner = attributes["owner"].as_str().unwrap().to_owned();
        let generation = attributes["generation"].as_str().unwrap().to_owned();
        let groups: Vec<_> = owner.split('-').map(str::len).collect();
        assert_eq!(groups, [8, 4, 4, 4, 12], "{kind}: {owner}");
        assert!(lowercase_hex(&owner.replace('-', "")), "{kind}: {owner}");
        assert_eq!(&owner[14..15], "4", "{kind}: {owner} is not a random UUID");
        assert!(
            generation.len() == 32 && lowercase_hex(&generation),
            "{kind}: {generation}"
        );
        let labels = volumes.lock().unwrap().volumes["authored-credentials"]["Labels"].clone();
        assert_eq!(labels["nemoclaw.nvidia.com/uid"], owner, "{kind}");
        assert_eq!(
            labels["nemoclaw.nvidia.com/generation"], generation,
            "{kind}"
        );
        let output = run(
            &workspace,
            &["plan", "-input=false", "-no-color", "-detailed-exitcode"],
        );
        assert_eq!(
            output.status.code(),
            Some(0),
            "{kind}: generated identity must not change: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(state_attributes(&workspace)["owner"], owner, "{kind}");
        assert_eq!(volumes.lock().unwrap().creates, 1, "{kind}");
    }
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn omitted_proxy_storage_identity_is_generated_and_labels_its_credential_volume() {
    let (engine, volumes) = volume_engine().await;
    let workspace = workspace();
    configure(
        &workspace,
        "nemoclaw_ollama_proxy_storage",
        "authored-proxy",
        None,
        &engine.endpoint,
    );
    success(
        &workspace,
        &["apply", "-input=false", "-auto-approve", "-no-color"],
    );
    let attributes = state_attributes(&workspace);
    let owner = attributes["owner"].as_str().unwrap().to_owned();
    let generation = attributes["generation"].as_str().unwrap().to_owned();
    assert_eq!(owner.len(), 36, "{owner}");
    assert!(
        generation.len() == 32 && lowercase_hex(&generation),
        "{generation}"
    );
    let labels = volumes.lock().unwrap().volumes["authored-proxy-auth"]["Labels"].clone();
    assert_eq!(labels["nemoclaw.nvidia.com/uid"], owner);
    assert_eq!(labels["nemoclaw.nvidia.com/generation"], generation);
    let output = run(
        &workspace,
        &["plan", "-input=false", "-no-color", "-detailed-exitcode"],
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "generated identity must not change: {}",
        String::from_utf8_lossy(&output.stdout)
    );
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
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker and Ollama fixtures"]
async fn authored_external_model_shares_proxy_identity_and_rechecks_its_digest() {
    let (engine, volumes) = volume_engine().await;
    let digest = Arc::new(Mutex::new("a".repeat(64)));
    let upstream = upstream(digest.clone()).await;
    let workspace = workspace();
    fs::write(
        workspace.path().join("main.tf"),
        format!(
            r#"terraform {{
  required_providers {{
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw" }}
  }}
}}

provider "nemoclaw" {{}}

resource "nemoclaw_ollama_proxy_storage" "credentials" {{
  name   = "nc-0123456789abcdef-ollama-proxy-local"
  engine = "{engine}"
}}

# The model shares its proxy's identity, so a new proxy re-verifies it.
resource "nemoclaw_ollama_external_model" "model" {{
  name       = nemoclaw_ollama_proxy_storage.credentials.name
  owner      = nemoclaw_ollama_proxy_storage.credentials.owner
  generation = nemoclaw_ollama_proxy_storage.credentials.generation
  engine     = "{engine}"
  upstream   = "{upstream}/v1"
  model      = "qwen3:0.6b"
  digest     = "{digest}"
}}
"#,
            engine = engine.endpoint,
            upstream = upstream.endpoint,
            digest = "a".repeat(64),
        ),
    )
    .unwrap();
    success(
        &workspace,
        &["apply", "-input=false", "-auto-approve", "-no-color"],
    );
    assert!(
        volumes
            .lock()
            .unwrap()
            .volumes
            .contains_key("nc-0123456789abcdef-ollama-proxy-local-auth")
    );
    let state: Value =
        serde_json::from_slice(&fs::read(workspace.path().join("terraform.tfstate")).unwrap())
            .unwrap();
    let attributes = |kind: &str| {
        state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["type"] == kind)
            .unwrap()["instances"][0]["attributes"]
            .clone()
    };
    let (storage, model) = (
        attributes("nemoclaw_ollama_proxy_storage"),
        attributes("nemoclaw_ollama_external_model"),
    );
    assert_eq!(model["owner"], storage["owner"]);
    assert_eq!(
        model["id"],
        format!(
            "{}/{}/{}",
            storage["owner"].as_str().unwrap(),
            storage["generation"].as_str().unwrap(),
            "a".repeat(64)
        )
    );
    success(
        &workspace,
        &["plan", "-input=false", "-no-color", "-detailed-exitcode"],
    );
    // A changed upstream digest stops planning and names the service's upstream.
    *digest.lock().unwrap() = "b".repeat(64);
    let output = run(&workspace, &["plan", "-input=false", "-no-color"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("services.local.upstream"), "{stderr}");
}
