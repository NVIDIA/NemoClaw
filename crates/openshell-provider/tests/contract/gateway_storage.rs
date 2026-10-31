// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored HCL for Docker gateway storage through pinned OpenTofu against a
//! fake Docker engine that keeps volumes, networks, containers, and the files
//! written into them.

use crate::{
    docker_engine::{DATA_ROOT, Engine, handle},
    http_fixture::Fixture,
    tofu::TofuWorkspace,
};
use serde_json::{Value, json};
use std::{
    fs,
    process::Output,
    sync::{Arc, Mutex},
};

const NAME: &str = "nc-0123456789abcdef-gateway";
const OWNER: &str = "302ff5e1-088d-42ce-959f-4ff4c3570c13";
const IMAGE: &str = "ghcr.io/nvidia/openshell/gateway@sha256:f0b36dba21d282c52e498c25289658cfd6cd4f343b0069fde5609e25b002cdea";

async fn docker_engine() -> (Fixture, Arc<Mutex<Engine>>) {
    let engine = Arc::new(Mutex::new(Engine::default()));
    let shared = engine.clone();
    let fixture = Fixture::engine(move |request| {
        Some(handle(
            &mut shared.lock().unwrap(),
            &request.method,
            &request.path,
            &request.body,
        ))
    })
    .await;
    (fixture, engine)
}

fn configure(workspace: &TofuWorkspace, engine: &str, generation: &str) {
    fs::write(
        workspace.path().join("main.tf"),
        format!(
            r#"terraform {{
  required_providers {{
    openshell = {{ source = "registry.opentofu.org/nvidia/openshell" }}
  }}
}}
provider "openshell" {{}}
resource "openshell_gateway_storage" "runtime" {{
  name           = "{NAME}"
  owner          = "{OWNER}"
  generation     = "{generation}"
  compute_driver = "docker"
  engine         = "{engine}"
  image          = "{IMAGE}"
  network_cidr   = "172.30.110.0/24"
}}
output "data_path" {{
  value = openshell_gateway_storage.runtime.data_path
}}
"#
        ),
    )
    .unwrap();
}

fn run(workspace: &TofuWorkspace, args: &[&str], success: bool) -> String {
    let output: Output = workspace.command().args(args).output().unwrap();
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.status.success(), success, "{text}");
    text
}

fn workspace() -> TofuWorkspace {
    crate::workspace()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn gateway_storage_initializes_once_rejects_drift_and_refuses_deletion() {
    let (fixture, engine) = docker_engine().await;
    let workspace = workspace();
    let state_path = workspace.path().join("terraform.tfstate");
    configure(&workspace, &fixture.endpoint, "not-a-generation");
    let invalid = run(&workspace, &["validate", "-no-color"], false);
    assert!(
        invalid.contains("must be 32 lowercase hexadecimal characters"),
        "{invalid}"
    );
    configure(&workspace, &fixture.endpoint, &"b".repeat(32));
    run(&workspace, &["validate", "-no-color"], true);
    run(
        &workspace,
        &["plan", "-input=false", "-no-color", "-out=create.plan"],
        true,
    );
    assert_eq!(engine.lock().unwrap().mutations, Vec::<String>::new());
    assert!(!state_path.exists());

    run(
        &workspace,
        &["apply", "-input=false", "-no-color", "create.plan"],
        true,
    );
    let data = format!("{DATA_ROOT}/volumes/{NAME}-data/_data");
    {
        let engine = engine.lock().unwrap();
        assert_eq!(
            engine.mutations,
            [
                "POST /networks/create",
                "POST /volumes/create",
                "POST /containers/create",
                "POST /containers/container-0/start",
                "POST /containers/container-0/wait",
                "PUT /containers/container-0/archive",
            ]
        );
        assert_eq!(
            engine.files
                [&format!("{data}/state/openshell/gateway/credentials/key-encryption-key.bin")]
                .len(),
            32
        );
        // Storage holds data and credentials; each gateway container
        // receives its own configuration file.
        assert!(!engine.files.contains_key(&format!("{data}/gateway.toml")));
    }
    let output: Value =
        serde_json::from_str(&run(&workspace, &["output", "-json", "data_path"], true)).unwrap();
    assert_eq!(output, json!(data));
    let state: Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    let id = state["resources"][0]["instances"][0]["attributes"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        id.starts_with(&format!("engine/{NAME}-data/2026-10-08T00:00:00Z/network/")),
        "{id}"
    );

    // Unchanged storage plans no change and is not initialized again.
    let mutations = engine.lock().unwrap().mutations.len();
    let unchanged = run(&workspace, &["plan", "-input=false", "-no-color"], true);
    assert!(unchanged.contains("No changes"), "{unchanged}");
    let bound = fs::read(&state_path).unwrap();

    // A gateway configuration file in storage is the container's, not
    // storage's: a different one leaves storage unchanged.
    engine
        .lock()
        .unwrap()
        .files
        .insert(format!("{data}/gateway.toml"), b"changed = true\n".to_vec());
    let configured = run(&workspace, &["plan", "-input=false", "-no-color"], true);
    assert!(configured.contains("No changes"), "{configured}");

    // A missing dependency fails the refresh, keeps the binding, and
    // recreates nothing.
    let volume = engine
        .lock()
        .unwrap()
        .volumes
        .remove(&format!("{NAME}-data"))
        .unwrap();
    for args in [
        &["plan", "-input=false", "-no-color"][..],
        &["apply", "-auto-approve", "-input=false", "-no-color"],
    ] {
        let absent = run(&workspace, args, false);
        assert!(absent.contains("recreation forbidden"), "{absent}");
    }
    assert_eq!(fs::read(&state_path).unwrap(), bound);
    engine
        .lock()
        .unwrap()
        .volumes
        .insert(format!("{NAME}-data"), volume);

    // Persistent storage outlives destroy; the binding is retained.
    let destroy = run(
        &workspace,
        &["destroy", "-auto-approve", "-input=false", "-no-color"],
        false,
    );
    assert!(
        destroy.contains("persistent storage deletion is forbidden"),
        "{destroy}"
    );
    crate::assert_same_managed_resources(&fs::read(&state_path).unwrap(), &bound);
    assert_eq!(engine.lock().unwrap().mutations.len(), mutations);
}
