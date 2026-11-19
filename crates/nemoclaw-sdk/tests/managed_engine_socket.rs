// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The engine socket a managed local gateway binds as `/var/run/docker.sock`.
//! An engine in a Linux VM, behind a Windows client's named pipe or a macOS
//! client's forwarded Unix socket, serves containers its socket in the VM.

use nemoclaw_sdk::{
    compile::{Generations, compile, runtime_targets},
    config::{Document, schema::input_schema},
    managed::Spec,
};
use serde_json::{Value, json};

const DOCKER_DESKTOP: &str = "npipe:////./pipe/docker_engine";
const PODMAN_MACHINE: &str = "npipe:////./pipe/podman-machine-default";
const VM_SOCKET: &str = "/var/run/docker.sock";

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
        "ollama_proxy",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

fn parse(value: &Value) -> Document {
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(value),
        "the input schema refuses {}",
        value["spec"]["gateway"]
    );
    Document::parse(value.to_string().as_bytes()).unwrap()
}

fn gateway_spec(document: &Document) -> Spec {
    let targets = runtime_targets(document, &generations()).unwrap();
    let target = targets
        .iter()
        .find(|target| target.kind == "managed_gateway")
        .unwrap();
    Spec::from_gateway_row(&target.kind, &target.values).unwrap()
}

/// The socket the managed gateway's container binds as `/var/run/docker.sock`:
/// for Docker, the gateway container's volume in the graph OpenTofu applies;
/// for Podman, the bind in the container the provider creates.
fn bound_socket(driver: &str, engine: &str) -> String {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric.yaml")).unwrap();
    value["spec"]["gateway"] =
        json!({"management": "managed", "runtime": {"provider": driver}, "engine": engine});
    let document = parse(&value);
    if driver == "docker" {
        let graph = compile(&document, &generations(), "0.1.0").unwrap();
        // OpenTofu's Docker provider reaches the engine at the client's address.
        assert_eq!(graph["provider"]["docker"][0]["host"], engine);
        let volumes = &graph["resource"]["docker_container"]["managed_gateway_runtime"]["volumes"];
        assert_eq!(volumes[0]["container_path"], VM_SOCKET);
        return volumes[0]["host_path"].as_str().unwrap().into();
    }
    gateway_spec(&document)
        .container("/owned")
        .unwrap()
        .host_config
        .unwrap()
        .mounts
        .unwrap()
        .into_iter()
        .find(|mount| mount.target.as_deref() == Some(VM_SOCKET))
        .and_then(|mount| mount.source)
        .unwrap()
}

#[test]
fn a_managed_gateway_on_a_named_pipe_binds_the_engine_vm_docker_socket() {
    for (driver, pipe) in [("docker", DOCKER_DESKTOP), ("podman", PODMAN_MACHINE)] {
        assert_eq!(bound_socket(driver, pipe), VM_SOCKET, "{driver}");
    }
}

/// On macOS every engine runs in a Linux VM, and the client's socket is the
/// forwarded end of the engine's socket there. Docker Desktop, Colima, Rancher
/// Desktop and a Podman machine serve their engine to containers at
/// `/var/run/docker.sock` in the VM. On other clients, and for a socket that
/// names none of these engines, the gateway binds the socket's own path.
#[test]
fn a_managed_gateway_binds_the_engine_socket_of_the_macos_vm_behind_its_unix_socket() {
    let macos = cfg!(target_os = "macos");
    for (driver, engine, in_vm) in [
        ("docker", "unix:///Users/me/.docker/run/docker.sock", macos),
        ("docker", "unix:///Users/me/.colima/default/docker.sock", macos),
        ("docker", "unix:///Users/me/.colima/docker.sock", macos),
        ("docker", "unix:///Users/me/.config/colima/work/docker.sock", macos),
        ("docker", "unix:///Users/me/.rd/docker.sock", macos),
        (
            "podman",
            "unix:///var/folders/xy/abc/T/podman/podman-machine-default-api.sock",
            macos,
        ),
        ("docker", "unix:///var/run/docker.sock", false),
        ("docker", "unix:///Users/me/.lima/docker/sock/docker.sock", false),
        ("docker", "unix:///home/me/.docker/desktop/docker.sock", false),
        ("podman", "unix:///run/user/501/podman/podman.sock", false),
    ] {
        let own = engine.strip_prefix("unix://").unwrap();
        assert_eq!(
            bound_socket(driver, engine),
            if in_vm { VM_SOCKET } else { own },
            "{engine}"
        );
    }
}

#[test]
fn services_on_a_managed_gateway_on_a_named_pipe_use_its_engine() {
    // A managed inference service runs on the gateway's engine.
    let mut vllm: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    vllm["spec"]["gateway"]["engine"] = json!(DOCKER_DESKTOP);
    let document = parse(&vllm);
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    assert_eq!(graph["provider"]["docker"][0]["host"], DOCKER_DESKTOP);

    // An application container shares the gateway's engine.
    let mut application = crate::support::example("application-container.yaml");
    application["spec"]["gateway"]["engine"] = json!(DOCKER_DESKTOP);
    parse(&application);

    // An Ollama proxy without an engine of its own uses the gateway's.
    let mut proxy: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/managed-ollama.yaml")).unwrap();
    proxy["spec"]["inferenceProviders"]["local"]["serviceRef"] = json!("ollama-auth");
    proxy["spec"]["services"] = json!({"ollama-auth": {
        "kind": "ollamaProxy",
        "image": format!("nc-ollama-proxy@sha256:{}", "a".repeat(64)),
        "endpoint": "http://172.20.0.1:11435/v1",
        "upstream": {"endpoint": "http://127.0.0.1:11434/v1",
            "model": {"name": "qwen3:0.6b", "digest": "a".repeat(64)}}
    }});
    proxy["spec"]["gateway"]["engine"] = json!(DOCKER_DESKTOP);
    let graph = compile(&parse(&proxy), &generations(), "0.1.0").unwrap();
    assert_eq!(
        graph["resource"]["ollama_proxy_credential_storage"]["ollama-auth"]["engine"],
        DOCKER_DESKTOP
    );
}

#[test]
fn a_managed_gateway_refuses_an_engine_on_another_host() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric.yaml")).unwrap();
    for engine in [
        "ssh://operator@gpu-box",
        "npipe:////remote/pipe/docker_engine",
        "tcp://127.0.0.1:2375",
    ] {
        value["spec"]["gateway"] = json!({"management": "managed", "engine": engine});
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "accepted {engine}"
        );
    }
}
