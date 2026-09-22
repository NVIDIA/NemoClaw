// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{compile, runtime_targets, targets},
    config::Document,
};
use serde_json::json;

#[test]
fn kubernetes_compiles_only_openshell_resources_and_checks_the_driver_before_mutation() {
    let input = include_str!("fixtures/config/local.yaml")
        .replace("provider: docker", "provider: kubernetes");
    let document = Document::parse(input.as_bytes()).unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    assert!(runtime_targets(&document, &generations).unwrap().is_empty());
    assert!(
        targets(&document, &generations)
            .unwrap()
            .iter()
            .all(|target| {
                matches!(
                    target.kind.as_str(),
                    "workspace" | "provider_profile" | "provider" | "sandbox"
                )
            })
    );
    assert!(graph["provider"].get("docker").is_none());
    assert!(
        graph["terraform"]["required_providers"]
            .get("docker")
            .is_none()
    );
    for phase in ["current", "apply"] {
        assert_eq!(
            graph["data"]["nemoclaw_gateway_capabilities"][phase]["required_compute_drivers"],
            json!(["kubernetes"])
        );
    }
    for (kind, resources) in graph["resource"].as_object().unwrap() {
        assert!(kind.starts_with("nemoclaw_"));
        for resource in resources.as_object().unwrap().values() {
            assert!(
                resource["depends_on"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("data.nemoclaw_gateway_capabilities.apply"))
            );
            assert_eq!(
                resource["lifecycle"]["precondition"][0]["condition"],
                "${data.nemoclaw_gateway_capabilities.current.compatible}"
            );
        }
    }
    assert_eq!(
        graph["resource"]["nemoclaw_sandbox"]["assistant"]["lifecycle"]["prevent_destroy"],
        true
    );
}
