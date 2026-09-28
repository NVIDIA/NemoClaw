// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deterministic protocol fixtures shared by SDK and bundle lifecycle tests.
pub mod openshell;

#[cfg(unix)]
#[path = "../../test-support/docker.rs"]
pub mod docker;

fn select_sandbox_bindings(
    targets: &[nemoclaw_sdk::compile::Target],
    state: &serde_json::Value,
) -> Result<std::collections::BTreeMap<String, nemoclaw_sdk::backend::Row>, &'static str> {
    use std::collections::{BTreeMap, BTreeSet};
    let expected: BTreeMap<_, _> = targets
        .iter()
        .filter(|target| target.kind == "sandbox")
        .map(|target| (target.address.as_str(), &target.values))
        .collect();
    if expected.is_empty() {
        return Err("expected at least one declared sandbox");
    }
    let mut bindings = BTreeMap::new();
    let mut ids = BTreeSet::new();
    for resource in state["resources"]
        .as_array()
        .ok_or("missing resources")?
        .iter()
        .filter(|resource| resource["type"] == "nemoclaw_sandbox")
    {
        if resource["mode"] != "managed" || !resource["module"].is_null() {
            return Err("unexpected sandbox resource address");
        }
        let address = format!(
            "nemoclaw_sandbox.{}",
            resource["name"].as_str().ok_or("missing sandbox address")?
        );
        let target = expected
            .get(address.as_str())
            .ok_or("undeclared sandbox binding")?;
        let instances = resource["instances"]
            .as_array()
            .ok_or("missing sandbox instances")?;
        let [instance] = instances.as_slice() else {
            return Err("expected one current sandbox instance");
        };
        if !instance["deposed"].is_null() || !instance["index_key"].is_null() {
            return Err("unexpected sandbox instance address");
        }
        let binding: nemoclaw_sdk::backend::Row =
            serde_json::from_value(instance["attributes"].clone())
                .map_err(|_| "invalid sandbox binding")?;
        for field in [
            "name",
            "workspace",
            "owner",
            "generation",
            "agent_name",
            "agent_runtime",
            "inference_json",
        ] {
            if target.get(field).is_none_or(String::is_empty)
                || binding.get(field) != target.get(field)
            {
                return Err("sandbox binding disagrees with declared ownership or agent");
            }
        }
        let id = binding
            .get("id")
            .filter(|id| !id.is_empty())
            .ok_or("missing sandbox ID")?;
        if !ids.insert(id.clone()) || bindings.insert(binding["name"].clone(), binding).is_some() {
            return Err("duplicate sandbox binding");
        }
    }
    if bindings.len() != expected.len() {
        return Err("missing declared sandbox binding");
    }
    Ok(bindings)
}

#[test]
fn multiple_sandbox_selection_requires_exact_owned_bindings() {
    use nemoclaw_sdk::{compile, config::Document};
    use serde_json::json;
    let document = Document::parse(
        include_str!("../../../examples/kubernetes/managed-development.yaml").as_bytes(),
    )
    .unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|kind| (kind.into(), format!("{kind}-generation")))
        .collect();
    let targets: Vec<_> = compile::targets(&document, &generations)
        .unwrap()
        .into_iter()
        .filter(|target| target.kind == "sandbox")
        .collect();
    assert_eq!(targets.len(), 3);
    let resources: Vec<_> = targets
        .iter()
        .rev()
        .map(|target| {
            let mut attributes = target.values.clone();
            attributes.insert("id".into(), format!("physical-{}", attributes["name"]));
            json!({
                "mode": "managed", "type": "nemoclaw_sandbox",
                "name": target.values["name"], "instances": [{"attributes": attributes}]
            })
        })
        .collect();
    let state = json!({"resources": resources});
    let selected = select_sandbox_bindings(&targets, &state).unwrap();
    assert_eq!(
        selected.keys().map(String::as_str).collect::<Vec<_>>(),
        ["assistant", "researcher", "reviewer"]
    );
    for (name, binding) in &selected {
        assert_eq!(binding["id"], format!("physical-{name}"));
    }
    for path in [
        "/resources/0/name",
        "/resources/0/mode",
        "/resources/0/instances/0/attributes/name",
        "/resources/0/instances/0/attributes/owner",
        "/resources/0/instances/0/attributes/generation",
        "/resources/0/instances/0/attributes/workspace",
        "/resources/0/instances/0/attributes/agent_name",
        "/resources/0/instances/0/attributes/agent_runtime",
        "/resources/0/instances/0/attributes/inference_json",
    ] {
        let mut invalid = state.clone();
        *invalid.pointer_mut(path).unwrap() = json!("foreign");
        assert!(
            select_sandbox_bindings(&targets, &invalid).is_err(),
            "{path}"
        );
    }
    for id in [
        json!(""),
        state["resources"][1]["instances"][0]["attributes"]["id"].clone(),
    ] {
        let mut invalid = state.clone();
        invalid["resources"][0]["instances"][0]["attributes"]["id"] = id;
        assert!(select_sandbox_bindings(&targets, &invalid).is_err());
    }
    let mut missing = state.clone();
    missing["resources"].as_array_mut().unwrap().pop();
    assert!(select_sandbox_bindings(&targets, &missing).is_err());
    let mut duplicate = state.clone();
    duplicate["resources"]
        .as_array_mut()
        .unwrap()
        .push(state["resources"][0].clone());
    assert!(select_sandbox_bindings(&targets, &duplicate).is_err());
    let mut extra_instance = state.clone();
    extra_instance["resources"][0]["instances"]
        .as_array_mut()
        .unwrap()
        .push(state["resources"][0]["instances"][0].clone());
    assert!(select_sandbox_bindings(&targets, &extra_instance).is_err());
    let mut deposed = state.clone();
    deposed["resources"][0]["instances"][0]["deposed"] = json!("old");
    assert!(select_sandbox_bindings(&targets, &deposed).is_err());
    let mut indexed = state.clone();
    indexed["resources"][0]["instances"][0]["index_key"] = json!(0);
    assert!(select_sandbox_bindings(&targets, &indexed).is_err());
    let mut module = state.clone();
    module["resources"][0]["module"] = json!("module.foreign");
    assert!(select_sandbox_bindings(&targets, &module).is_err());
    let single = json!({"resources": [state["resources"][2].clone()]});
    assert_eq!(
        select_sandbox_bindings(&targets[..1], &single)
            .unwrap()
            .len(),
        1
    );
}

/// Explicit, opt-in generation check for one owned OpenClaw or Hermes deployment.
/// Preserves the single-sandbox contract used by existing lifecycle tests.
pub async fn verify_agent(
    document: &nemoclaw_sdk::config::Document,
    directory: &std::path::Path,
) -> String {
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("terraform.tfstate")).unwrap())
            .unwrap();
    let sandboxes: Vec<_> = state["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|resource| resource["type"] == "nemoclaw_sandbox")
        .collect();
    assert_eq!(sandboxes.len(), 1);
    let binding =
        serde_json::from_value(sandboxes[0]["instances"][0]["attributes"].clone()).unwrap();
    verify_bound_agents(document, directory, [(String::new(), binding)].into())
        .await
        .pop_first()
        .unwrap()
        .1
}

/// Verify one real response per declared sandbox using its exact retained binding.
/// Holds one managed gateway tunnel across all requests; never runs as part of apply.
pub async fn verify_agents(
    document: &nemoclaw_sdk::config::Document,
    directory: &std::path::Path,
) -> std::collections::BTreeMap<String, String> {
    use nemoclaw_sdk::config::Document;
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("terraform.tfstate")).unwrap())
            .unwrap();
    let intent: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.join("intent.json")).unwrap()).unwrap();
    let retained: Document = serde_json::from_value(intent["document"].clone()).unwrap();
    assert_eq!(
        retained.digest(),
        document.digest(),
        "configuration must match retained intent"
    );
    let generations = serde_json::from_value(intent["generations"].clone()).unwrap();
    let targets = nemoclaw_sdk::compile::targets(document, &generations).unwrap();
    // Validate the complete set before opening a tunnel or invoking any agent.
    let bindings = select_sandbox_bindings(&targets, &state).unwrap();
    verify_bound_agents(document, directory, bindings).await
}

async fn verify_bound_agents(
    document: &nemoclaw_sdk::config::Document,
    directory: &std::path::Path,
    bindings: std::collections::BTreeMap<String, nemoclaw_sdk::backend::Row>,
) -> std::collections::BTreeMap<String, String> {
    use nemoclaw_sdk::openshell::{EnvironmentSecrets, OpenShell};
    let connection = if document.spec.gateway.as_kubernetes().is_some() {
        let intent: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("intent.json")).unwrap()).unwrap();
        let generations = serde_json::from_value(intent["generations"].clone()).unwrap();
        Some(
            nemoclaw_sdk::kubernetes::connection(
                document,
                &generations,
                directory,
                &EnvironmentSecrets,
                &nemoclaw_sdk::CancellationToken::new(),
            )
            .await
            .unwrap(),
        )
    } else {
        None
    };
    let client = if let Some(connection) = &connection {
        connection
            .client(std::sync::Arc::new(EnvironmentSecrets))
            .unwrap()
    } else {
        OpenShell::connect(
            &document.spec.gateway,
            std::sync::Arc::new(EnvironmentSecrets),
        )
        .unwrap()
    };
    let mut responses = std::collections::BTreeMap::new();
    for (name, binding) in bindings {
        client
            .inference_ready(&binding)
            .await
            .unwrap_or_else(|error| panic!("sandbox {name}: inference readiness failed: {error}"));
        let response = client
            .agent_response(&binding)
            .await
            .unwrap_or_else(|error| panic!("sandbox {name}: agent response failed: {error}"));
        responses.insert(name, response);
    }
    responses
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
