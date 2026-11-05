// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed Docker or Podman gateway renders `spec.gateway.config`, in the
//! OpenShell chart's `gatewayConfig` format, into the gateway's TOML file
//! beside the keys NemoClaw owns.

use nemoclaw_sdk::{
    compile::{Generations, runtime_targets},
    config::Document,
    managed::Spec,
};
use serde_json::{Value, json};

fn managed(driver: &str, config: Option<Value>) -> Result<Document, String> {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric.yaml")).unwrap();
    value["spec"]["gateway"] = json!({"management": "managed"});
    if driver == "podman" {
        value["spec"]["gateway"]["engine"] = json!("unix:///run/user/1000/podman/podman.sock");
        value["spec"]["gateway"]["runtime"] = json!({"provider": "podman"});
    }
    if let Some(config) = config {
        value["spec"]["gateway"]["config"] = config;
    }
    Document::parse(value.to_string().as_bytes()).map_err(|error| error.to_string())
}

fn gateway_toml(document: &Document) -> toml::Value {
    let generations: Generations = [("managed_gateway".into(), "a".repeat(32))].into();
    let targets = runtime_targets(document, &generations).unwrap();
    let target = targets
        .iter()
        .find(|t| t.kind == "managed_gateway")
        .unwrap();
    let spec = Spec::from_gateway_row(&target.kind, &target.values).unwrap();
    toml::from_str(&spec.gateway_config("/owned").unwrap()).unwrap()
}

#[test]
fn authored_tables_reach_the_gateway_file_beside_owned_keys() {
    for driver in ["docker", "podman"] {
        let document = managed(
            driver,
            Some(json!({
                format!("openshell.drivers.{driver}"): {"allow_driver_config": true},
                format!("openshell.drivers.{driver}.resource_admission.required_labels"): {
                    "team.example/attachable": "true"
                },
                "openshell.gateway": {
                    "log_level": "debug",
                    "otlp": {"endpoint": "http://collector.example:4317"}
                },
                "openshell.supervisor.middleware": [{"name": "audit"}, {"name": "trace"}]
            })),
        )
        .unwrap();
        let config = gateway_toml(&document);
        let openshell = &config["openshell"];
        let section = &openshell["drivers"][driver];
        assert_eq!(
            section["allow_driver_config"].as_bool(),
            Some(true),
            "{driver}"
        );
        assert_eq!(
            section["resource_admission"]["required_labels"]["team.example/attachable"].as_str(),
            Some("true"),
            "{driver}"
        );
        assert!(section["supervisor_image"].as_str().is_some(), "{driver}");
        assert_eq!(openshell["gateway"]["log_level"].as_str(), Some("debug"));
        assert_eq!(
            openshell["gateway"]["otlp"]["endpoint"].as_str(),
            Some("http://collector.example:4317")
        );
        assert_eq!(
            openshell["gateway"]["compute_driver"].as_str(),
            Some(driver)
        );
        assert_eq!(openshell["gateway"]["disable_tls"].as_bool(), Some(true));
        let middleware = openshell["supervisor"]["middleware"].as_array().unwrap();
        assert_eq!(middleware.len(), 2);
        assert_eq!(middleware[1]["name"].as_str(), Some("trace"));
    }
}

#[test]
fn without_authored_tables_only_owned_keys_are_written() {
    for driver in ["docker", "podman"] {
        let config = gateway_toml(&managed(driver, None).unwrap());
        let openshell = config["openshell"].as_table().unwrap();
        assert_eq!(
            openshell.keys().collect::<Vec<_>>(),
            ["drivers", "gateway", "version"],
            "{driver}"
        );
        assert!(
            config["openshell"]["drivers"][driver]
                .get("allow_driver_config")
                .is_none()
        );
    }
}

#[test]
fn keys_nemoclaw_owns_are_rejected_in_either_form() {
    for (driver, config, key) in [
        (
            "docker",
            json!({"openshell.gateway": {"disable_tls": false}}),
            "openshell.gateway.disable_tls",
        ),
        (
            "docker",
            json!({"openshell": {"gateway": {"compute_driver": "vm"}}}),
            "openshell.gateway.compute_driver",
        ),
        (
            "docker",
            json!({"openshell.gateway.gateway_jwt": {"kid_path": "/kid"}}),
            "openshell.gateway.gateway_jwt.kid_path",
        ),
        (
            "docker",
            json!({"openshell.gateway.auth": {"allow_unauthenticated_users": false}}),
            "openshell.gateway.auth.allow_unauthenticated_users",
        ),
        (
            "docker",
            json!({"openshell.drivers.docker": {"sandbox_label": "other"}}),
            "openshell.drivers.docker.sandbox_label",
        ),
        (
            "podman",
            json!({"openshell.drivers.podman": {"socket_path": "/run/podman.sock"}}),
            "openshell.drivers.podman.socket_path",
        ),
        (
            "podman",
            json!({"openshell": {"version": 3}}),
            "openshell.version",
        ),
    ] {
        let error = managed(driver, Some(config)).unwrap_err();
        assert!(error.contains("spec.gateway.config"), "{error}");
        assert!(error.contains(key), "{key}: {error}");
    }
}

#[test]
fn a_table_defined_twice_is_rejected() {
    let error = managed(
        "docker",
        Some(json!({
            "openshell.gateway": {"otlp": {"endpoint": "http://a:4317"}},
            "openshell.gateway.otlp": {"service_name": "gateway"}
        })),
    )
    .unwrap_err();
    assert!(error.contains("openshell.gateway.otlp"), "{error}");
}

#[test]
fn tables_must_be_maps_or_lists_of_maps() {
    for config in [
        json!({"openshell.gateway": "debug"}),
        json!({"openshell.supervisor.middleware": ["audit"]}),
        json!({"openshell..gateway": {"log_level": "debug"}}),
    ] {
        let error = managed("docker", Some(config.clone())).unwrap_err();
        assert!(error.contains("spec.gateway.config"), "{config}: {error}");
    }
}

#[test]
fn an_external_gateway_takes_no_config() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric.yaml")).unwrap();
    value["spec"]["gateway"]["config"] = json!({"openshell.gateway": {"log_level": "debug"}});
    let error = Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(error.contains("config"), "{error}");
}
