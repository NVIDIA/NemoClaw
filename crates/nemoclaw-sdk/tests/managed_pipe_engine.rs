// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed local gateway on a Windows client's named-pipe engine. The client
//! reaches Docker Desktop or a Podman machine through the pipe, and the gateway
//! container, which runs in that engine's Linux VM, binds the VM's
//! `/var/run/docker.sock`.

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

#[test]
fn a_managed_gateway_on_a_named_pipe_binds_the_engine_vm_docker_socket() {
    for (driver, pipe) in [("docker", DOCKER_DESKTOP), ("podman", PODMAN_MACHINE)] {
        let mut value: Value =
            serde_saphyr::from_str(include_str!("../../../examples/fabric.yaml")).unwrap();
        value["spec"]["gateway"] =
            json!({"management": "managed", "target": {driver: {"engine": pipe}}});
        let document = parse(&value);
        let spec = gateway_spec(&document);
        let mounts = spec
            .container("/owned")
            .unwrap()
            .host_config
            .unwrap()
            .mounts
            .unwrap();
        assert!(
            mounts
                .iter()
                .any(|mount| mount.source.as_deref() == Some(VM_SOCKET)
                    && mount.target.as_deref() == Some(VM_SOCKET)),
            "{driver}: the gateway must bind the VM's engine socket: {mounts:?}"
        );
        if driver == "docker" {
            // OpenTofu's Docker provider reaches the engine through the pipe,
            // and the gateway container it creates binds the VM's socket.
            let graph = compile(&document, &generations(), "0.1.0").unwrap();
            assert_eq!(graph["provider"]["docker"][0]["host"], pipe);
            assert_eq!(
                graph["resource"]["docker_container"]["managed_gateway_runtime"]["volumes"],
                json!([{"host_path": VM_SOCKET, "container_path": VM_SOCKET}])
            );
        }
    }
}

#[test]
fn services_on_a_managed_gateway_on_a_named_pipe_use_its_engine() {
    // A managed inference service runs on the gateway's engine.
    let mut vllm: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    vllm["spec"]["gateway"]["target"]["docker"]["engine"] = json!(DOCKER_DESKTOP);
    let document = parse(&vllm);
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    assert_eq!(graph["provider"]["docker"][0]["host"], DOCKER_DESKTOP);

    // An application container shares the gateway's engine.
    let mut application = crate::support::example("application-container.yaml");
    application["spec"]["gateway"]["target"]["docker"]["engine"] = json!(DOCKER_DESKTOP);
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
    proxy["spec"]["gateway"]["target"]["docker"]["engine"] = json!(DOCKER_DESKTOP);
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
        value["spec"]["gateway"] =
            json!({"management": "managed", "target": {"docker": {"engine": engine}}});
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "accepted {engine}"
        );
    }
}
