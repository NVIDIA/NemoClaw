// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deterministic protocol fixtures shared by SDK and bundle lifecycle tests.
pub mod openshell;

#[cfg(unix)]
#[path = "../../test-support/docker.rs"]
pub mod docker;

/// Explicit, opt-in generation check for an owned live OpenClaw or Hermes deployment.
/// Reads its durable sandbox binding; does not run as part of apply.
pub async fn verify_agent(
    document: &nemoclaw_sdk::config::Document,
    directory: &std::path::Path,
) -> String {
    use nemoclaw_sdk::{
        backend::Row,
        openshell::{EnvironmentSecrets, OpenShell},
    };
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("terraform.tfstate")).unwrap())
            .unwrap();
    let sandboxes: Vec<_> = state["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["type"] == "nemoclaw_sandbox")
        .collect();
    assert_eq!(sandboxes.len(), 1);
    let binding: Row =
        serde_json::from_value(sandboxes[0]["instances"][0]["attributes"].clone()).unwrap();
    let client = OpenShell::connect(
        &document.spec.gateway,
        std::sync::Arc::new(EnvironmentSecrets),
    )
    .unwrap();
    client.inference_ready(&binding).await.unwrap();
    client.agent_response(&binding).await.unwrap()
}

/// OpenTofu may reorder cached precondition results and advance the serial on
/// otherwise unchanged apply. Sandbox observations also carry a fresh operation
/// token. Every other field, including health, bindings and check outcomes, must
/// remain identical. Failed-observation tests still compare bytes.
pub fn assert_same_deployment_state(actual: &[u8], expected: &[u8]) {
    fn normalize(bytes: &[u8]) -> serde_json::Value {
        let mut state: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert!(
            state
                .as_object_mut()
                .unwrap()
                .remove("serial")
                .unwrap()
                .is_u64()
        );
        if let Some(resources) = state["resources"].as_array_mut() {
            for resource in resources {
                if resource["mode"] == "data"
                    && resource["type"] == "nemoclaw_sandbox_readiness"
                    && let Some(instances) = resource["instances"].as_array_mut()
                {
                    for instance in instances {
                        instance["attributes"]
                            .as_object_mut()
                            .unwrap()
                            .remove("read_trigger");
                    }
                }
            }
        }
        if let Some(checks) = state
            .get_mut("check_results")
            .and_then(serde_json::Value::as_array_mut)
        {
            checks.sort_by_cached_key(|check| serde_json::to_string(check).unwrap());
        }
        state
    }
    assert_eq!(normalize(actual), normalize(expected));
}

#[test]
fn unchanged_state_comparison_preserves_bindings_and_check_outcomes() {
    let before = serde_json::json!({
        "serial": 1, "lineage": "owned",
        "resources": [{"instances":[{"attributes":{"id":"physical"}}]}],
        "check_results": [{"name":"first","status":"pass"}, {"name":"second","status":"pass"}]
    });
    let mut reordered = before.clone();
    reordered["serial"] = serde_json::json!(2);
    reordered["check_results"].as_array_mut().unwrap().reverse();
    assert_same_deployment_state(
        reordered.to_string().as_bytes(),
        before.to_string().as_bytes(),
    );
    for path in [
        "/lineage",
        "/resources/0/instances/0/attributes/id",
        "/check_results/0/status",
    ] {
        let mut changed = before.clone();
        *changed.pointer_mut(path).unwrap() = serde_json::json!("changed");
        assert!(
            std::panic::catch_unwind(|| assert_same_deployment_state(
                changed.to_string().as_bytes(),
                before.to_string().as_bytes()
            ))
            .is_err(),
            "{path} must not be normalized away"
        );
    }
}

/// Failed apply may record new data-source observations and condition results.
/// Its managed resources and deployment lineage must still be preserved.
pub fn assert_same_managed_resources(actual: &[u8], expected: &[u8]) {
    fn managed(bytes: &[u8]) -> (String, Vec<serde_json::Value>) {
        let state: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        let resources = state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|resource| match resource["mode"].as_str() {
                Some("managed") => true,
                Some("data") => false,
                _ => panic!("unexpected resource mode"),
            })
            .cloned()
            .collect();
        (state["lineage"].as_str().unwrap().into(), resources)
    }
    assert_eq!(managed(actual), managed(expected));
}

#[test]
fn failed_apply_preserves_managed_resources_but_may_record_failed_observations() {
    let before = serde_json::json!({
        "lineage":"owned",
        "resources":[
            {"mode":"managed","instances":[{"attributes":{"id":"owned"}}]},
            {"mode":"data","instances":[{"attributes":{"compatible":true}}]}
        ]
    });
    let mut observed = before.clone();
    observed["resources"][1]["instances"][0]["attributes"]["compatible"] = serde_json::json!(false);
    assert_same_managed_resources(
        observed.to_string().as_bytes(),
        before.to_string().as_bytes(),
    );
    for path in ["/lineage", "/resources/0/instances/0/attributes/id"] {
        let mut changed = observed.clone();
        *changed.pointer_mut(path).unwrap() = serde_json::json!("foreign");
        assert!(
            std::panic::catch_unwind(|| assert_same_managed_resources(
                changed.to_string().as_bytes(),
                before.to_string().as_bytes()
            ))
            .is_err(),
            "{path}"
        );
    }
}

#[test]
fn sandbox_completion_state_comparison_ignores_only_the_operation_token() {
    let before = serde_json::json!({"serial":1,"resources":[{
        "mode":"data","type":"nemoclaw_sandbox_readiness",
        "instances":[{"attributes":{"read_trigger":"old", "ready":true, "health_json":"unsupported"}}]
    }]});
    let mut after = before.clone();
    after["resources"][0]["instances"][0]["attributes"]["read_trigger"] =
        serde_json::json!("fresh");
    assert_same_deployment_state(after.to_string().as_bytes(), before.to_string().as_bytes());
    after["resources"][0]["instances"][0]["attributes"]["ready"] = serde_json::json!(false);
    assert!(
        std::panic::catch_unwind(|| assert_same_deployment_state(
            after.to_string().as_bytes(),
            before.to_string().as_bytes()
        ))
        .is_err()
    );
}
