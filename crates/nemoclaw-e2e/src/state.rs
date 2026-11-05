// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Readers for what a live deployment records in OpenTofu state: each
//! sandbox's binding and its agent's runtime ID, the resources the state
//! binds, and the managed gateway's Helm release; and Fabric's run results.
use nemoclaw_sdk::backend::Row;
use serde_json::Value;
use std::{fs, path::Path};

/// The resources in the deployment's OpenTofu state.
fn resources(directory: &Path) -> Vec<Value> {
    let state: Value =
        serde_json::from_slice(&fs::read(directory.join("terraform.tfstate")).unwrap()).unwrap();
    state["resources"].as_array().unwrap().clone()
}

/// The managed resource of `kind` named `name`, from the deployment's
/// OpenTofu state.
fn resource(directory: &Path, kind: &str, name: &str) -> Value {
    resources(directory)
        .into_iter()
        .find(|resource| {
            resource["mode"] == "managed" && resource["type"] == kind && resource["name"] == name
        })
        .unwrap_or_else(|| panic!("the state records no {kind}.{name}"))
}

/// The address of each managed resource that the deployment's OpenTofu state
/// binds, such as `openshell_kubernetes_storage.runtime`.
pub fn bound(directory: &Path) -> Vec<String> {
    resources(directory)
        .iter()
        .filter(|resource| resource["mode"] == "managed")
        .map(|resource| {
            let part = |key: &str| resource[key].as_str().unwrap().to_owned();
            format!("{}.{}", part("type"), part("name"))
        })
        .collect()
}

/// The name and namespace of the managed Kubernetes gateway's Helm release,
/// which authentication records whether or not the state binds the release.
pub fn gateway_release(directory: &Path) -> (String, String) {
    let auth = resource(directory, "openshell_kubernetes_auth", "runtime");
    let field = |key: &str| {
        auth["instances"][0]["attributes"][key]
            .as_str()
            .expect("authentication records the gateway release")
            .to_owned()
    };
    (field("name"), field("namespace"))
}

/// The binding of sandbox `name`, from the deployment's OpenTofu state.
pub fn sandbox_binding(directory: &Path, name: &str) -> Row {
    let sandbox = resource(directory, "openshell_sandbox", name);
    // Convert typed refs to the row fields the gateway client expects.
    let mut attributes = sandbox["instances"][0]["attributes"].clone();
    nemoclaw_openshell::flatten("openshell_sandbox", &mut attributes);
    attributes
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
        .collect()
}

/// The runtime ID Fabric gave the agent in sandbox `name`, from the
/// deployment's OpenTofu state.
pub fn runtime_id(directory: &Path, name: &str) -> String {
    let id = resource(directory, "fabric_agent", name)["instances"][0]["attributes"]["runtime_id"]
        .as_str()
        .expect("the agent records its runtime ID")
        .to_owned();
    assert!(!id.trim().is_empty());
    id
}

/// Whether a Fabric run result succeeded. Adapters own the output's meaning
/// and shape, so any output of a succeeded run counts.
pub fn successful_invocation(response: &[u8]) -> bool {
    serde_json::from_slice::<Value>(response).is_ok_and(|value| {
        value["status"] == "succeeded" && value["error"].is_null() && value.get("output").is_some()
    })
}

#[test]
fn sandbox_binding_preserves_the_workspace_from_its_typed_reference() {
    let directory = tempfile::tempdir().unwrap();
    let state = serde_json::json!({
        "resources": [{
            "mode": "managed",
            "type": "openshell_sandbox",
            "name": "assistant",
            "instances": [{"attributes": {
                "name": "assistant",
                "id": "sandbox-id",
                "owner": "owner",
                "generation": "generation",
                "workspace": {
                    "type": "openshell_workspace",
                    "name": "workspace",
                    "id": "workspace-id",
                    "owner": "owner",
                    "generation": "workspace-generation"
                }
            }}]
        }]
    });
    fs::write(
        directory.path().join("terraform.tfstate"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    assert_eq!(
        sandbox_binding(directory.path(), "assistant"),
        Row::from([
            ("name".into(), "assistant".into()),
            ("id".into(), "sandbox-id".into()),
            ("owner".into(), "owner".into()),
            ("generation".into(), "generation".into()),
            ("workspace".into(), "workspace".into()),
        ])
    );
}

#[test]
fn readers_select_the_named_managed_sandbox_and_its_agent() {
    let directory = tempfile::tempdir().unwrap();
    // Data sources of the same type and name come first, so a reader that
    // ignored the mode would return their values.
    let resources: Vec<Value> = [
        ("data", "first", "observed"),
        ("managed", "first", "first"),
        ("managed", "second", "second"),
    ]
    .into_iter()
    .flat_map(|(mode, name, value)| {
        [
            serde_json::json!({"mode":mode,"type":"openshell_sandbox","name":name,
                "instances":[{"attributes":{"id":format!("{value}-sandbox")}}]}),
            serde_json::json!({"mode":mode,"type":"fabric_agent","name":name,
                "instances":[{"attributes":{"runtime_id":format!("{value}-runtime")}}]}),
        ]
    })
    .collect();
    fs::write(
        directory.path().join("terraform.tfstate"),
        serde_json::to_vec(&serde_json::json!({ "resources": resources })).unwrap(),
    )
    .unwrap();
    for name in ["first", "second"] {
        assert_eq!(
            sandbox_binding(directory.path(), name)["id"],
            format!("{name}-sandbox")
        );
        assert_eq!(
            runtime_id(directory.path(), name),
            format!("{name}-runtime")
        );
    }
}

#[test]
fn readers_list_the_bound_resources_and_the_release_that_authentication_records() {
    let directory = tempfile::tempdir().unwrap();
    // A data source is observed, not bound.
    let state = serde_json::json!({"resources": [
        {"mode": "data", "type": "openshell_gateway", "name": "current", "instances": []},
        {"mode": "managed", "type": "openshell_kubernetes_storage", "name": "runtime",
            "instances": [{"attributes": {}}]},
        {"mode": "managed", "type": "openshell_kubernetes_auth", "name": "runtime",
            "instances": [{"attributes": {"name": "nc-gateway", "namespace": "nc-kind"}}]},
    ]});
    fs::write(
        directory.path().join("terraform.tfstate"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    assert_eq!(
        bound(directory.path()),
        [
            "openshell_kubernetes_storage.runtime",
            "openshell_kubernetes_auth.runtime"
        ]
    );
    assert_eq!(
        gateway_release(directory.path()),
        ("nc-gateway".to_owned(), "nc-kind".to_owned())
    );
}

#[test]
fn a_blank_agent_runtime_id_is_rejected() {
    for (recorded, accepted) in [("runtime", true), ("", false), (" ", false)] {
        let directory = tempfile::tempdir().unwrap();
        let state = serde_json::json!({"resources": [{
            "mode": "managed",
            "type": "fabric_agent",
            "name": "assistant",
            "instances": [{"attributes": {"runtime_id": recorded}}]
        }]});
        fs::write(
            directory.path().join("terraform.tfstate"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        assert_eq!(
            std::panic::catch_unwind(|| runtime_id(directory.path(), "assistant")).is_ok(),
            accepted,
            "runtime ID {recorded:?}"
        );
    }
}

#[test]
fn failed_or_incomplete_results_are_not_successful_invocations() {
    for response in [
        serde_json::json!({"status":"failed","output":"anything"}),
        serde_json::json!({"status":"succeeded"}),
        serde_json::json!({"status":"succeeded","output":null,"error":{"message":"failed"}}),
    ] {
        assert!(!successful_invocation(
            &serde_json::to_vec(&response).unwrap()
        ));
    }
}

#[test]
fn successful_fabric_results_allow_adapter_owned_output_shapes() {
    for output in [
        serde_json::json!("native"),
        serde_json::json!([1, 2]),
        serde_json::json!({"artifact":"owned"}),
        Value::Null,
    ] {
        let result = serde_json::json!({"status":"succeeded","output":output,"error":null});
        assert!(successful_invocation(&serde_json::to_vec(&result).unwrap()));
    }
}
