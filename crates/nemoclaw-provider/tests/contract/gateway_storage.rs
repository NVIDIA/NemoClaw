// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored HCL for Docker gateway storage through pinned OpenTofu against a
//! fake Docker engine that keeps volumes, networks, containers, and the files
//! written into them.

use crate::{http_fixture::Fixture, tofu::TofuWorkspace};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    process::Output,
    sync::{Arc, Mutex},
};

const NAME: &str = "nc-0123456789abcdef-gateway";
const OWNER: &str = "302ff5e1-088d-42ce-959f-4ff4c3570c13";
const IMAGE: &str = "ghcr.io/nvidia/openshell/gateway@sha256:ea14aa4db0980fab4769fb6b5509ac42ae3dc8495e645b1ba1fe1ada49892fa6";
const DATA_ROOT: &str = "/var/lib/docker";

#[derive(Default)]
struct Engine {
    volumes: BTreeMap<String, Value>,
    networks: BTreeMap<String, Value>,
    containers: Vec<Value>,
    /// Files in volumes, by absolute path.
    files: BTreeMap<String, Vec<u8>>,
    /// Every request other than a read, as `METHOD path`.
    mutations: Vec<String>,
}

impl Engine {
    fn container(&mut self, reference: &str) -> Option<&mut Value> {
        self.containers.iter_mut().find(|container| {
            container["Id"] == reference || container["Name"] == format!("/{reference}")
        })
    }
}

/// The single-entry tar archive Docker's archive endpoint returns.
fn tar_entry(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut archive = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive.append_data(&mut header, name, bytes).unwrap();
    archive.into_inner().unwrap()
}

fn handle(engine: &mut Engine, method: &str, target: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let url = url::Url::parse(&format!("http://engine{target}")).unwrap();
    let query = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let path = url.path();
    let segments: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let json = |status, value: Value| (status, serde_json::to_vec(&value).unwrap());
    let missing = || json(404, json!({"message":"missing"}));
    if method != "GET" {
        engine.mutations.push(format!("{method} {path}"));
    }
    match (method, segments.as_slice()) {
        ("GET", ["info"]) => json(200, json!({"ID":"engine","DockerRootDir":DATA_ROOT})),
        ("POST", ["volumes", "create"]) => {
            let request: Value = serde_json::from_slice(body).unwrap();
            let name = request["Name"].as_str().unwrap().to_owned();
            let volume = json!({"Name":name,"Driver":"local","Scope":"local",
                "Mountpoint":format!("{DATA_ROOT}/volumes/{name}/_data"),
                "CreatedAt":"2026-10-08T00:00:00Z","Labels":request["Labels"],"Options":{}});
            engine.volumes.insert(name, volume.clone());
            json(201, volume)
        }
        ("GET", ["volumes", name]) => engine
            .volumes
            .get(*name)
            .map_or_else(missing, |volume| json(200, volume.clone())),
        ("GET", ["networks"]) => json(200, json!(engine.networks.values().collect::<Vec<_>>())),
        ("POST", ["networks", "create"]) => {
            let mut network: Value = serde_json::from_slice(body).unwrap();
            network["Id"] = json!("network");
            network["Internal"] = json!(false);
            network["EnableIPv6"] = json!(false);
            let name = network["Name"].as_str().unwrap().to_owned();
            engine.networks.insert(name, network);
            json(201, json!({"Id":"network","Warning":""}))
        }
        ("GET", ["networks", name]) => engine
            .networks
            .get(*name)
            .map_or_else(missing, |network| json(200, network.clone())),
        ("POST", ["containers", "create"]) => {
            let config: Value = serde_json::from_slice(body).unwrap();
            let mounts: Vec<_> = config["HostConfig"]["Mounts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|mount| json!({"Type":mount["Type"],"Name":mount["Source"],"Destination":mount["Target"],"RW":true}))
                .collect();
            let id = format!("container-{}", engine.containers.len());
            engine.containers.push(json!({
                "Id":id,"Name":format!("/{}", query("name").unwrap()),
                "Config":config,"HostConfig":config["HostConfig"],"Mounts":mounts,
                "State":{"Status":"created","Running":false,"ExitCode":0}
            }));
            json(201, json!({"Id":id,"Warnings":[]}))
        }
        ("GET", ["containers", reference, "json"]) => engine
            .container(reference)
            .map_or_else(missing, |container| json(200, container.clone())),
        // The initializer generates the gateway's signing identity and exits.
        ("POST", ["containers", reference, "start"]) => {
            let Some(container) = engine.container(reference) else {
                return missing();
            };
            container["State"] = json!({"Status":"exited","Running":false,"ExitCode":0});
            let data = container["Mounts"][0]["Destination"]
                .as_str()
                .unwrap()
                .to_owned();
            engine
                .files
                .insert(format!("{data}/tls/jwt/public.pem"), b"public".to_vec());
            (204, Vec::new())
        }
        ("POST", ["containers", _, "wait"]) => json(200, json!({"StatusCode":0})),
        ("GET", ["containers", _, "archive"]) => {
            let file = query("path").unwrap();
            match engine.files.get(&file) {
                Some(bytes) => (200, tar_entry(file.rsplit('/').next().unwrap(), bytes)),
                None => missing(),
            }
        }
        ("PUT", ["containers", _, "archive"]) => {
            let directory = query("path").unwrap();
            let mut archive = tar::Archive::new(body);
            for entry in archive.entries().unwrap() {
                let mut entry = entry.unwrap();
                if entry.header().entry_type().is_file() {
                    let name = entry.path().unwrap().to_str().unwrap().to_owned();
                    let mut bytes = Vec::new();
                    entry.read_to_end(&mut bytes).unwrap();
                    engine.files.insert(format!("{directory}/{name}"), bytes);
                }
            }
            (200, Vec::new())
        }
        _ => panic!("unexpected Docker request {method} {target}"),
    }
}

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
  required_version = "= 1.12.6"
  required_providers {{
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw" }}
  }}
}}
provider "nemoclaw" {{}}
resource "nemoclaw_gateway_storage" "runtime" {{
  name           = "{NAME}"
  owner          = "{OWNER}"
  generation     = "{generation}"
  compute_driver = "docker"
  engine         = "{engine}"
  image          = "{IMAGE}"
  network_cidr   = "172.30.110.0/24"
}}
output "data_path" {{
  value = nemoclaw_gateway_storage.runtime.data_path
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
                "PUT /containers/container-0/archive",
            ]
        );
        assert_eq!(
            engine.files
                [&format!("{data}/state/openshell/gateway/credentials/key-encryption-key.bin")]
                .len(),
            32
        );
        assert!(engine.files.contains_key(&format!("{data}/gateway.toml")));
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

    // Changed configuration or a missing dependency fails the refresh, keeps
    // the binding, and recreates nothing.
    let configuration = format!("{data}/gateway.toml");
    let original = engine.lock().unwrap().files[&configuration].clone();
    engine
        .lock()
        .unwrap()
        .files
        .insert(configuration.clone(), b"changed = true\n".to_vec());
    let drift = run(&workspace, &["plan", "-input=false", "-no-color"], false);
    assert!(
        drift.contains("gateway storage configuration differs from this bundle"),
        "{drift}"
    );
    engine.lock().unwrap().files.insert(configuration, original);
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
