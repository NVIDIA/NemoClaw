// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed gateway passes OpenShell's sandbox driver configuration setting
//! through to the gateway it installs.

use nemoclaw_sdk::{
    compile::{Generations, runtime_targets},
    config::Document,
    managed::Spec,
};
use serde_json::{Value, json};

fn managed(driver: &str, setting: Option<Value>) -> Result<Document, String> {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric.yaml")).unwrap();
    value["spec"]["gateway"] = json!({"management": "managed"});
    if driver == "podman" {
        value["spec"]["gateway"]["engine"] = json!("unix:///run/user/1000/podman/podman.sock");
        value["spec"]["gateway"]["runtime"] = json!({"provider": "podman"});
    }
    if let Some(setting) = setting {
        value["spec"]["gateway"]["sandboxDriverConfig"] = setting;
    }
    Document::parse(value.to_string().as_bytes()).map_err(|error| error.to_string())
}

fn gateway_toml(document: &Document) -> (String, toml::Value) {
    let generations: Generations = [("managed_gateway".into(), "a".repeat(32))].into();
    let targets = runtime_targets(document, &generations).unwrap();
    let target = targets
        .iter()
        .find(|t| t.kind == "managed_gateway")
        .unwrap();
    let spec = Spec::from_gateway_row(&target.kind, &target.values).unwrap();
    let text = spec.gateway_config("/owned");
    let parsed = toml::from_str(&text).unwrap();
    (text, parsed)
}

#[test]
fn a_managed_gateway_allows_sandbox_driver_config_when_asked() {
    for driver in ["docker", "podman"] {
        let document = managed(
            driver,
            Some(json!({
                "allow": true,
                "resourceAdmission": {
                    "enabled": true,
                    "requiredLabels": {"team.example/attachable": "true"}
                }
            })),
        )
        .unwrap();
        let (_, config) = gateway_toml(&document);
        let section = &config["openshell"]["drivers"][driver];
        assert_eq!(
            section["allow_driver_config"].as_bool(),
            Some(true),
            "{driver}"
        );
        assert_eq!(
            section["resource_admission"]["enabled"].as_bool(),
            Some(true),
            "{driver}"
        );
        assert_eq!(
            section["resource_admission"]["required_labels"]["team.example/attachable"].as_str(),
            Some("true"),
            "{driver}"
        );
    }
}

#[test]
fn without_the_setting_the_gateway_configuration_is_unchanged() {
    for driver in ["docker", "podman"] {
        let (text, config) = gateway_toml(&managed(driver, None).unwrap());
        assert!(!text.contains("allow_driver_config"), "{driver}");
        assert!(!text.contains("resource_admission"), "{driver}");
        assert!(
            config["openshell"]["drivers"][driver]
                .get("allow_driver_config")
                .is_none()
        );
    }
}

#[test]
fn an_empty_required_label_map_is_rejected() {
    let error = managed(
        "docker",
        Some(json!({"allow": true, "resourceAdmission": {"requiredLabels": {}}})),
    )
    .unwrap_err();
    assert!(error.contains("sandboxDriverConfig"), "{error}");
}
