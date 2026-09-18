// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
#[test]
fn gateway_launch_uses_version_two_configuration_and_supported_process_flags() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    let launch = spec.container("/owned").unwrap();
    let command = launch.cmd.unwrap();
    for flag in command.iter().filter(|arg| arg.starts_with("--")) {
        assert!(
            ["--config", "--name", "--bind-address", "--port"].contains(&flag.as_str()),
            "unsupported process flag: {flag}"
        );
    }
    assert!(
        launch
            .env
            .unwrap()
            .contains(&"OPENSHELL_DB_URL=sqlite:/owned/gateway.db".into())
    );
    let config = spec.gateway_config("/owned");
    assert!(config.starts_with("[openshell]\nversion = 2\n"));
    assert!(config.contains("compute_driver = \"docker\""));
    assert!(!config.contains("ttl_secs = 0"));
    assert!(config.contains("sandbox_runtime_image = \"ghcr.io/nvidia/openshell/sandbox@sha256:"));
    assert!(config.contains("supervisor_image = \"ghcr.io/nvidia/openshell/supervisor@sha256:"));
    assert!(!config.contains("supervisor_bin"));
    assert!(!config.contains("ssh_socket_path"));
}
#[test]
fn invalid_placement_network_does_not_panic() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut value: serde_json::Value =
        serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
    value["process"]["engine"] = json!("ssh://host");
    value["process"]["network_cidr"] = json!("invalid");
    let spec: Spec = serde_json::from_value(value).unwrap();
    assert!(spec.bridge().is_err());
}
#[test]
fn runtime_configuration_handles_a_gateway_without_panicking() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    assert!(spec.process.is_none());
    assert!(matches!(
        spec.runtime_configuration(),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn runtime_configuration_rejects_invalid_specs_and_preserves_opaque_input() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
    let expected = spec.process.as_ref().unwrap().configuration.clone();
    assert_eq!(spec.runtime_configuration().unwrap(), expected);
    let process = spec.process.take().unwrap();
    assert!(spec.runtime_configuration().is_err());
    spec.process = Some(process);
    spec.generation.clear();
    assert!(spec.runtime_configuration().is_err());
}

#[test]
fn runtime_specs_preserve_ownership_and_explicit_launch_contracts() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    for fixture in fixtures {
        let source = fixture["spec"].as_str().unwrap();
        let spec: Spec = serde_json::from_str(source).unwrap();
        spec.validate().unwrap();
        assert_eq!(spec.json().unwrap(), source);
        assert_eq!(
            serde_json::to_value(spec.labels().unwrap()).unwrap(),
            fixture["labels"]
        );
        let create = serde_json::to_value(
            spec.container("/var/lib/docker/volumes/fixture/_data")
                .unwrap(),
        )
        .unwrap();
        for key in ["Image", "User", "Entrypoint", "Cmd", "Env", "Labels"] {
            assert_eq!(create[key], fixture["config"][key], "{key}");
        }
        for key in [
            "NetworkMode",
            "CapDrop",
            "SecurityOpt",
            "RestartPolicy",
            "Mounts",
            "PortBindings",
            "Memory",
            "MemorySwap",
            "DeviceRequests",
            "Ulimits",
            "ShmSize",
            "LogConfig",
        ] {
            assert_eq!(
                without_null_members(create["HostConfig"][key].clone()),
                without_null_members(fixture["hostConfig"][key].clone()),
                "{key}"
            );
        }
        assert_eq!(
            spec.gateway_config("/var/lib/docker/volumes/fixture/_data"),
            fixture["gatewayConfig"].as_str().unwrap()
        );
    }
}
#[test]
fn managed_specs_reject_missing_ownership_or_unknown_runtime_layout() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let valid: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    for field in ["owner", "generation", "layout", "kind", "name"] {
        let mut spec = valid.clone();
        match field {
            "owner" => spec.owner.clear(),
            "generation" => spec.generation.clear(),
            "layout" => spec.layout = 3,
            "kind" => spec.kind = "arbitrary".into(),
            "name" => spec.name = "unrelated".into(),
            _ => unreachable!(),
        }
        assert!(
            spec.container("/var/lib/docker/volumes/fixture/_data")
                .is_err()
        );
    }
}

// Docker treats absent and null optional device maps equivalently.
// Preserve every non-null launch value.
fn without_null_members(mut value: serde_json::Value) -> serde_json::Value {
    match &mut value {
        serde_json::Value::Object(map) => {
            map.retain(|_, value| !value.is_null());
            for value in map.values_mut() {
                *value = without_null_members(value.take());
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                *value = without_null_members(value.take());
            }
        }
        _ => {}
    }
    value
}

#[test]
fn podman_gateway_namespace_survives_info_id_changes_but_not_network_replacement() {
    let fixtures: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("reference.json")).unwrap();
    let mut spec: Spec = serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap();
    spec.compute_driver = "podman".into();
    let network = "a".repeat(64);
    let first = spec
        .binding_namespace(Some("random-first"), Some(&network))
        .unwrap();
    assert_eq!(
        first,
        spec.binding_namespace(Some("random-next"), Some(&network))
            .unwrap()
    );
    assert_ne!(
        first,
        spec.binding_namespace(Some("random-first"), Some(&"b".repeat(64)))
            .unwrap()
    );
    assert!(spec.binding_namespace(Some("random-first"), None).is_err());
}
