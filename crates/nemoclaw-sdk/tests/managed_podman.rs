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
    let config = spec.gateway_config("/owned");
    assert!(config.contains("compute_driver = \"podman\""));
    assert!(config.contains("[openshell.drivers.podman]"));
    assert!(config.contains("socket_path = \"/var/run/docker.sock\""));
    let launch = serde_json::to_value(spec.container("/owned").unwrap()).unwrap();
    assert_eq!(
        launch["HostConfig"]["Mounts"][1]["Source"],
        "/run/user/1000/podman/podman.sock"
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
