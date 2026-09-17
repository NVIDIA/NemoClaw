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
fn agent_order_does_not_change_compiled_identity_or_settings() {
    let mut value = example();
    let mut other = value["spec"]["sandboxes"][0]["agents"][0].clone();
    other["name"] = json!("bob");
    let mut provider = value["spec"]["inferenceProviders"][0].clone();
    provider["name"] = json!("other-models");
    provider["endpoint"] = json!("http://172.20.0.1:11447/v1");
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(provider);
    other["inference"]["routes"][0]["providerRef"] = json!("other-models");
    value["spec"]["sandboxes"][0]["agents"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let before = graph(&value);
    value["spec"]["sandboxes"][0]["agents"]
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
