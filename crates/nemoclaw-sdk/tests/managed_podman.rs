// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, runtime_targets},
    config::{Document, schema::input_schema},
    managed::Spec,
};
use serde_json::{Value, json};

#[test]
fn managed_podman_selects_one_driver_and_mounts_the_declared_socket() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric.yaml")).unwrap();
    value["spec"]["gateway"] =
        json!({"management":"managed","engine":"unix:///run/user/1000/podman/podman.sock"});
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("podman");
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let generations: Generations = [("managed_gateway".into(), "a".repeat(32))].into();
    let targets = runtime_targets(&doc, &generations).unwrap();
    let target = targets
        .iter()
        .find(|t| t.kind == "managed_gateway")
        .unwrap();
    let spec: Spec = serde_json::from_str(&target.values["spec"]).unwrap();
    let config: toml::Value = toml::from_str(&spec.gateway_config("/owned")).unwrap();
    let openshell = &config["openshell"];
    assert_eq!(
        openshell["gateway"]["compute_driver"].as_str(),
        Some("podman")
    );
    let socket = openshell["drivers"]["podman"]["socket_path"]
        .as_str()
        .unwrap();
    let launch = spec.container("/owned").unwrap();
    let host = launch.host_config.unwrap();
    let mounts = host.mounts.unwrap();
    let socket_mount = mounts
        .iter()
        .find(|mount| mount.target.as_deref() == Some(socket))
        .expect("the configured Podman socket must be mounted into the gateway");
    assert_eq!(
        socket_mount.source.as_deref(),
        Some("/run/user/1000/podman/podman.sock")
    );
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("other");
    other["runtime"]["provider"] = json!("docker");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
