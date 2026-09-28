// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "ollama",
        "managed_gateway",
        "inference_service",
    ]
    .map(|name| (name.into(), "a".repeat(32)))
    .into()
}
fn example() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap()
}
fn graph(value: &Value) -> Value {
    compile(
        &Document::parse(value.to_string().as_bytes()).unwrap(),
        &generations(),
        "0.1.0",
    )
    .unwrap()
}
#[test]
fn mixed_sandboxes_share_providers_and_ignore_declaration_order() {
    let mut value = example();
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("research");
    other["harness"] = json!({"kind":"deepagents"});
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    assert!(
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let before = graph(&value);
    assert_eq!(
        before["resource"]["nemoclaw_sandbox"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        before["resource"]["nemoclaw_provider"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
    value["spec"]["sandboxes"].as_array_mut().unwrap().reverse();
    assert_eq!(before, graph(&value));
}
#[test]
fn sandbox_and_provider_order_do_not_change_compiled_identity_or_settings() {
    let mut value = example();
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("bob");
    let mut provider = value["spec"]["inferenceProviders"][0].clone();
    provider["name"] = json!("other-models");
    provider["endpoint"] = json!("http://172.20.0.1:11447/v1");
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(provider);
    other["agent"]["inference"]["routes"][0]["providerRef"] = json!("other-models");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let before = graph(&value);
    value["spec"]["sandboxes"].as_array_mut().unwrap().reverse();
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(before, graph(&value));
}

#[test]
fn sandbox_local_provider_and_inference_names_do_not_escape_their_scope() {
    let mut value = example();
    let provider = value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    value["spec"]["sandboxes"][0]["inferenceProviders"] = json!([provider]);
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("other");
    other["inferenceProviders"][0]["endpoint"] = json!("http://172.20.0.1:11447/v1");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let before = graph(&value);
    let providers = before["resource"]["nemoclaw_provider"].as_object().unwrap();
    assert_eq!(providers.len(), 2);
    assert_ne!(
        providers.values().next().unwrap()["name"],
        providers.values().next_back().unwrap()["name"]
    );
    value["spec"]["sandboxes"].as_array_mut().unwrap().reverse();
    assert_eq!(before, graph(&value));
}

#[test]
fn adding_a_sandbox_preserves_existing_resource_addresses_and_values() {
    let mut value = example();
    let before = graph(&value);
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("additional");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let after = graph(&value);
    for (kind, instances) in before["resource"].as_object().unwrap() {
        for (name, instance) in instances.as_object().unwrap() {
            assert_eq!(instance, &after["resource"][kind][name]);
        }
    }
}

#[test]
fn reordering_named_declarations_preserves_pending_intent_digest() {
    let mut value = example();
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("another");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let before = Document::parse(value.to_string().as_bytes())
        .unwrap()
        .digest();
    value["spec"]["sandboxes"].as_array_mut().unwrap().reverse();
    assert_eq!(
        before,
        Document::parse(value.to_string().as_bytes())
            .unwrap()
            .digest()
    );
}

#[test]
fn five_agent_example_compiles_to_five_independent_sandboxes_sharing_inference() {
    let value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/multiple-sandboxes.yaml")).unwrap();
    assert!(
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    let rows = nemoclaw_sdk::compile::targets(&document, &generations()).unwrap();
    let sandboxes: Vec<_> = rows.iter().filter(|row| row.kind == "sandbox").collect();
    assert_eq!(sandboxes.len(), 5);
    assert_eq!(rows.iter().filter(|row| row.kind == "provider").count(), 1);
    let mut counts = std::collections::BTreeMap::new();
    let mut names = std::collections::BTreeSet::new();
    for sandbox in &document.spec.sandboxes {
        let harness = document.sandbox_harness(sandbox).unwrap();
        *counts.entry(harness.kind.as_str()).or_insert(0) += 1;
        assert!(names.insert(sandbox.name.as_str()));
        let row = sandboxes
            .iter()
            .find(|row| row.values["name"] == sandbox.name)
            .unwrap();
        let configuration = rows
            .iter()
            .find(|candidate| {
                candidate.kind == "agent_configuration" && candidate.values["name"] == sandbox.name
            })
            .unwrap();
        let settings: Value = serde_json::from_str(&configuration.values["config_json"]).unwrap();
        assert_eq!(settings["metadata"]["name"], sandbox.agent.name);
        assert_eq!(row.values["agent_name"], sandbox.agent.name);
    }
    assert_eq!(
        counts,
        [
            ("nvidia.fabric.openclaw", 2),
            ("nvidia.fabric.langchain.deepagents", 2),
            ("nvidia.fabric.pi", 1)
        ]
        .into()
    );
}

#[test]
fn managed_discovery_preserves_request_identity_when_sandboxes_are_reordered() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/onboarding/openclaw.yaml")).unwrap();
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("research");
    other["harness"] = json!({"kind":"deepagents"});
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let before = graph(&value);
    value["spec"]["sandboxes"].as_array_mut().unwrap().reverse();
    assert_eq!(before, graph(&value));
}
