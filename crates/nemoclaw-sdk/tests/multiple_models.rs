// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};
fn input() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap()
}
fn choices() -> Value {
    let mut value = input();
    let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
    let mut fast = inference["routes"][0].clone();
    fast["name"] = json!("fast");
    fast["overrides"]["model"] = json!("fast-model");
    inference["routes"].as_array_mut().unwrap().push(fast);
    inference["default"] = json!("fast");
    value
}
#[test]
fn multiple_models_preserve_named_choices_and_each_agents_default() {
    let mut value = choices();
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("other");
    other["agent"]["inference"]["default"] = json!("primary");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let doc = Document::parse(value.to_string().as_bytes()).expect("multiple named models");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    assert_eq!(rows.iter().filter(|row| row.kind == "provider").count(), 1);
    let runtime: Value = serde_json::from_str(
        &rows
            .iter()
            .find(|row| row.kind == "sandbox")
            .unwrap()
            .values["inference_json"],
    )
    .unwrap();
    assert_eq!(runtime["connection"]["model"], "fast-model");
    let descriptor: Value = serde_json::from_str(include_str!(
        "../../../image/fabric/openclaw.fabric-adapter.json"
    ))
    .unwrap();
    jsonschema::validator_for(&descriptor["settings_schema"])
        .unwrap()
        .validate(&json!({"agent_name": "main", "inference": runtime}))
        .expect("compiled settings must satisfy the Fabric adapter contract");
    assert_eq!(runtime["agents"][0]["inference"]["default"], "fast");
    let other_runtime: Value = serde_json::from_str(
        &rows
            .iter()
            .find(|row| row.kind == "sandbox" && row.values["name"] == "other")
            .unwrap()
            .values["inference_json"],
    )
    .unwrap();
    assert_eq!(runtime["agents"].as_array().unwrap().len(), 1);
    assert_eq!(other_runtime["agents"].as_array().unwrap().len(), 1);
    assert_eq!(
        other_runtime["agents"][0]["inference"]["default"],
        "primary"
    );
    assert_eq!(
        runtime["agents"][0]["inference"]["models"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
}
#[test]
fn ambiguous_defaults_duplicate_choices_and_unsupported_harnesses_are_rejected() {
    let mut missing = choices();
    missing["spec"]["sandboxes"][0]["agent"]["inference"]
        .as_object_mut()
        .unwrap()
        .remove("default");
    let mut unknown = choices();
    unknown["spec"]["sandboxes"][0]["agent"]["inference"]["default"] = json!("missing");
    let mut duplicate = choices();
    duplicate["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][1]["name"] = json!("primary");
    let mut hermes = choices();
    hermes["spec"]["sandboxes"][0]["harness"]["kind"] = json!("hermes");
    for value in [missing, unknown, duplicate, hermes] {
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
}

#[test]
fn pi_choices_preserve_native_metadata_and_provider_credentials() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-pi.yaml")).unwrap();
    let mut provider = value["spec"]["inferenceProviders"][0].clone();
    provider["name"] = json!("hosted");
    provider["endpoint"] = json!("https://hosted.example/v1");
    provider["credential"] = json!({"env":"HOSTED_KEY"});
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(provider);
    let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
    let mut hosted = inference["routes"][0].clone();
    hosted["name"] = json!("smart");
    hosted["providerRef"] = json!("hosted");
    hosted["overrides"]["model"] = json!("custom-smart");
    hosted["overrides"]["piModel"]["maxTokens"] = json!(4096);
    inference["routes"].as_array_mut().unwrap().push(hosted);
    inference["default"] = json!("primary");
    let doc = Document::parse(value.to_string().as_bytes()).expect("Pi supports model choices");
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    let settings: Value = serde_json::from_str(
        &rows.iter().find(|t| t.kind == "sandbox").unwrap().values["inference_json"],
    )
    .unwrap();
    let choices = &settings["agents"][0]["inference"]["models"];
    assert_eq!(choices["smart"]["pi"]["model"], "custom-smart");
    assert_eq!(choices["smart"]["pi"]["piModel"]["maxTokens"], 4096);
    assert_eq!(
        choices["smart"]["connection"]["api_key_env"],
        "NEMOCLAW_INFERENCE_HOSTED_KEY"
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
}
