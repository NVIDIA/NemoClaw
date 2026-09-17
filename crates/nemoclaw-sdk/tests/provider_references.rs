// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[path = "support/provider_scope.rs"]
mod provider_scope;
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap()
}
fn inline(mut value: Value) -> Value {
    let provider = value["spec"]["inferenceProviders"][0].clone();
    value["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders");
    let route = &mut value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0];
    route.as_object_mut().unwrap().remove("providerRef");
    route["provider"] = provider;
    value
}
#[test]
fn provider_declaration_scope_preserves_intent_and_compiles_identically() {
    let shared = input();
    let mut sandbox = shared.clone();
    sandbox["spec"]["sandboxes"][0]["inferenceProviders"] = sandbox["spec"]
        .as_object_mut()
        .unwrap()
        .remove("inferenceProviders")
        .unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let expected = targets(
        &Document::parse(shared.to_string().as_bytes()).unwrap(),
        &generations,
    )
    .unwrap();
    for value in [shared, sandbox, inline(input())] {
        let doc = Document::parse(value.to_string().as_bytes())
            .expect("all provider declaration forms parse");
        assert!(
            jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
        assert_eq!(
            provider_scope::normalized(targets(&doc, &generations).unwrap()),
            expected
        );
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );
    }
}
#[test]
fn route_requires_exactly_one_provider_form() {
    for patch in [
        json!({}),
        json!({"providerRef":"local", "provider":input()["spec"]["inferenceProviders"][0]}),
    ] {
        let mut value = input();
        let route = &mut value["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0];
        route.as_object_mut().unwrap().remove("providerRef");
        route
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(
            !jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
    }
}
#[test]
fn unused_provider_definitions_require_no_secrets_or_resources() {
    let mut value = input();
    let original = Document::parse(value.to_string().as_bytes()).unwrap();
    value["spec"]["inferenceProviders"].as_array_mut().unwrap().insert(0, json!({"name":"unused", "provider":"openai", "endpoint":"https://example.com/v1", "credential":{"env":"UNUSED_KEY"}}));
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    assert_eq!(
        targets(&doc, &generations).unwrap(),
        targets(&original, &generations).unwrap()
    );
    assert!(!doc.credential_names().contains(&"UNUSED_KEY"));
    assert!(doc.yaml().unwrap().contains("UNUSED_KEY"));
}
#[test]
fn hermes_auth_uses_the_selected_inline_provider_without_a_second_reference() {
    let mut value = inline(input());
    value["spec"]["sandboxes"][0]["harness"]["kind"] = json!("hermes");
    let agent = &mut value["spec"]["sandboxes"][0]["agents"][0];
    agent["auth"] = json!({"method":"api-key"});
    agent["inference"]["routes"][0]["provider"]["endpoint"] =
        json!("https://inference.example.test/v1");
    agent["inference"]["routes"][0]["provider"]["credential"] = json!({"env":"INFERENCE_KEY"});
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    let settings: Value = serde_json::from_str(
        &rows.iter().find(|r| r.kind == "sandbox").unwrap().values["inference_json"],
    )
    .unwrap();
    assert_eq!(
        settings["auth"]["providerRef"],
        rows.iter()
            .find(|row| row.kind == "provider")
            .unwrap()
            .values["name"]
    );
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert!(!doc.yaml().unwrap().contains("providerRef"));
}
#[test]
fn references_reject_missing_names_shadowing_and_distinct_inline_instances() {
    let original = input();
    let provider = original["spec"]["inferenceProviders"][0].clone();
    let mut missing = original.clone();
    missing["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["providerRef"] =
        json!("missing");
    let mut duplicate = original.clone();
    duplicate["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(provider.clone());
    let mut shadow = original.clone();
    shadow["spec"]["sandboxes"][0]["inferenceProviders"] = json!([provider.clone()]);
    let mut inline_shadow = inline(original.clone());
    inline_shadow["spec"]["inferenceProviders"] = json!([provider]);
    let mut siblings = inline(original.clone());
    let mut other = siblings["spec"]["sandboxes"][0]["agents"][0].clone();
    other["name"] = json!("other");
    siblings["spec"]["sandboxes"][0]["agents"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let mut empty_ref = inline(original);
    empty_ref["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["providerRef"] =
        json!("");
    for value in [
        missing,
        duplicate,
        shadow,
        inline_shadow,
        siblings,
        empty_ref,
    ] {
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
}
#[test]
fn inline_managed_providers_preserve_runtime_graphs_and_defaults() {
    for input in [
        include_str!("../../../examples/managed-ollama.yaml"),
        include_str!("../../../examples/vllm.yaml"),
        include_str!("../../../examples/remote-vllm.yaml"),
    ] {
        let value: Value = serde_saphyr::from_str(input).unwrap();
        let shared = Document::parse(input.as_bytes()).unwrap();
        let local = Document::parse(inline(value).to_string().as_bytes()).unwrap();
        let generations: Generations = [
            "workspace",
            "provider",
            "sandbox",
            "ollama",
            "managed_gateway",
            "inference_service",
        ]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
        assert_eq!(
            provider_scope::normalized_as(
                targets(&local, &generations).unwrap(),
                &shared.inference_provider().unwrap().name
            ),
            targets(&shared, &generations).unwrap()
        );
        assert_eq!(
            nemoclaw_sdk::compile::runtime_targets(&local, &generations).unwrap(),
            nemoclaw_sdk::compile::runtime_targets(&shared, &generations).unwrap()
        );
        assert_eq!(local.has_runtime(), shared.has_runtime());
        assert_eq!(
            Document::parse(local.yaml().unwrap().as_bytes()).unwrap(),
            local
        );
    }
}
