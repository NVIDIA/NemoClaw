// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
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

// Docker treats absent and null optional device maps equivalently; Go emits
// null maps while Bollard omits them. Preserve every non-null launch value.
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
