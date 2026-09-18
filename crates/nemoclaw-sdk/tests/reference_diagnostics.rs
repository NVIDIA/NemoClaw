// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::Document;
use serde_json::{Value, json};

fn input() -> Value {
    serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap()
}
fn error(value: Value) -> String {
    Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string()
}
#[test]
fn missing_references_identify_the_consumer_and_visible_names() {
    for (field, definitions, kind) in [
        ("harness", "harnesses", "harness"),
        ("inference", "inferences", "inference"),
    ] {
        let mut v = input();
        let path = if field == "harness" {
            "/spec/sandboxes/0"
        } else {
            "/spec/sandboxes/0/agent"
        };
        let definition = v
            .pointer_mut(path)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field)
            .unwrap();
        v["spec"][definitions] = json!({"smart": definition});
        v.pointer_mut(path).unwrap()[format!("{field}Ref")] = json!("smrat");
        let consumer = if field == "harness" {
            "spec.sandboxes[assistant].harnessRef"
        } else {
            "spec.sandboxes[assistant].agent.inferenceRef"
        };
        assert_eq!(
            error(v),
            format!("{consumer}: unknown {kind} \"smrat\"; visible definitions: smart")
        );
    }
    let mut v = input();
    v["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["providerRef"] = json!("missing");
    assert_eq!(
        error(v),
        "spec.sandboxes[assistant].agent.inference.routes[primary].providerRef: unknown provider \"missing\"; visible definitions: local"
    );
    let mut v = input();
    v["spec"]["integrations"] =
        json!({"search":{"kind":"webSearch","provider":"brave","credential":{"env":"SEARCH_KEY"}}});
    v["spec"]["sandboxes"][0]["agent"]["integrationRefs"] = json!(["serach"]);
    assert_eq!(
        error(v),
        "spec.sandboxes[assistant].agent.integrationRefs[0]: unknown integration \"serach\"; visible definitions: search"
    );
}
#[test]
fn shared_inference_does_not_suggest_sandbox_local_providers() {
    let mut v = input();
    let inference = v["spec"]["sandboxes"][0]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("inference")
        .unwrap();
    v["spec"]["inferences"] = json!({"smart": inference});
    v["spec"]["sandboxes"][0]["agent"]["inferenceRef"] = json!("smart");
    let providers = v["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders")
        .unwrap();
    v["spec"]["sandboxes"][0]["inferenceProviders"] = providers;
    assert_eq!(
        error(v),
        "spec.inferences[smart].routes[primary].providerRef: unknown provider \"local\"; visible definitions: (none)"
    );
}

#[test]
fn visible_names_are_sorted_and_exclude_other_sandboxes() {
    let mut v = input();
    let definition = v["spec"]["sandboxes"][0]["harness"].clone();
    v["spec"]["harnesses"] = json!({"zulu": definition});
    v["spec"]["sandboxes"][0]["harnesses"] = json!({"alpha": definition});
    let mut other = v["spec"]["sandboxes"][0].clone();
    other["name"] = json!("other");
    other["harnesses"] = json!({"private": definition});
    v["spec"]["sandboxes"].as_array_mut().unwrap().push(other);
    v["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("harness");
    v["spec"]["sandboxes"][0]["harnessRef"] = json!("missing");
    assert_eq!(
        error(v),
        "spec.sandboxes[assistant].harnessRef: unknown harness \"missing\"; visible definitions: alpha, zulu"
    );
}

#[test]
fn malformed_reference_values_are_not_echoed() {
    let mut v = input();
    v["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["providerRef"] =
        json!("https://user:secret@example.com\nforged diagnostic");
    let message = error(v);
    assert!(message.contains("unknown provider \"<invalid name>\""));
    assert!(!message.contains("secret"));
    assert!(!message.contains('\n'));
}
