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
fn different_adapters_separate_provider_grants() {
    let mut value = example();
    let mut other = value["spec"]["sandboxes"]["assistant"].clone();
    other["harness"] = json!({"kind":"deepagents"});
    value["spec"]["sandboxes"]["research"] = other;
    assert!(
        jsonschema::validator_for(&nemoclaw_sdk::config::schema::input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let before = graph(&value);
    assert_eq!(
        before["resource"]["openshell_sandbox"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        before["resource"]["openshell_inference"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn sandbox_local_provider_and_inference_names_do_not_escape_their_scope() {
    let mut value = example();
    let providers = value["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders")
        .unwrap();
    value["spec"]["sandboxes"]["assistant"]["inferenceProviders"] = providers;
    let mut other = value["spec"]["sandboxes"]["assistant"].clone();
    other["inferenceProviders"]["local"]["endpoint"] = json!("http://172.20.0.1:11447/v1");
    value["spec"]["sandboxes"]["other"] = other;
    let before = graph(&value);
    let providers = before["resource"]["openshell_inference"]
        .as_object()
        .unwrap();
    assert_eq!(providers.len(), 2);
    assert_ne!(
        providers.values().next().unwrap()["name"],
        providers.values().next_back().unwrap()["name"]
    );
}

#[test]
fn adding_a_sandbox_preserves_existing_resource_addresses_and_values() {
    let mut value = example();
    let before = graph(&value);
    let other = value["spec"]["sandboxes"]["assistant"].clone();
    value["spec"]["sandboxes"]["additional"] = other;
    let after = graph(&value);
    for (kind, instances) in before["resource"].as_object().unwrap() {
        for (name, instance) in instances.as_object().unwrap() {
            let mut prior = instance.clone();
            let mut next = after["resource"][kind][name].clone();
            // Each sandbox keeps its own read. A registration the new sandbox
            // shares takes its binaries from the first sharing sandbox in name
            // order; both reads have the same image and harness.
            for field in ["binaries", "binaries_json"] {
                prior.as_object_mut().unwrap().remove(field);
                next.as_object_mut().unwrap().remove(field);
            }
            assert_eq!(prior, next);
        }
    }
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
    assert_eq!(rows.iter().filter(|row| row.kind == "inference").count(), 3);
    let mut counts = std::collections::BTreeMap::new();
    for sandbox in document.sandboxes() {
        let harness = document.sandbox_harness(sandbox).unwrap();
        *counts.entry(harness.kind.as_str()).or_insert(0) += 1;
        let row = sandboxes
            .iter()
            .find(|row| row.values["name"] == sandbox.name)
            .unwrap();
        let configuration = rows
            .iter()
            .find(|candidate| {
                candidate.kind == "agent" && candidate.values["sandbox"] == sandbox.name
            })
            .unwrap();
        let settings: Value = nemoclaw_fabric::agent::compose(&configuration.values).unwrap();
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
