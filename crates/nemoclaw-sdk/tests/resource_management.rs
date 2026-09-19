// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};

fn input(source: &str) -> Value {
    serde_saphyr::from_str(source).unwrap()
}
fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}

#[test]
fn ownership_follows_configuration_instead_of_optional_annotations() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for (source, parent, field, declaration) in [
        (
            include_str!("../../../examples/fabric-openclaw.yaml"),
            "/spec/inferenceProviders/0",
            "management",
            json!("external"),
        ),
        (
            include_str!("../../../examples/managed-ollama-gpu.yaml"),
            "/spec/inferenceProviders/0",
            "management",
            json!("managed"),
        ),
        (
            include_str!("../../../examples/managed-ollama-gpu.yaml"),
            "/spec/gateway",
            "network",
            json!({"management":"managed"}),
        ),
        (
            include_str!("../../../examples/managed-ollama-gpu.yaml"),
            "/spec/gateway",
            "storage",
            json!({"management":"managed"}),
        ),
        (
            include_str!("../../../examples/managed-ollama-gpu.yaml"),
            "/spec/services/qwen",
            "management",
            json!("managed"),
        ),
        (
            include_str!("../../../examples/managed-ollama-gpu.yaml"),
            "/spec/services/qwen",
            "storage",
            json!({"management":"managed"}),
        ),
        (
            include_str!("../../../examples/managed-ollama-gpu.yaml"),
            "/spec/services/qwen/model",
            "management",
            json!("managed"),
        ),
        (
            include_str!("../../../examples/spark/vllm.yaml"),
            "/spec/services/qwen",
            "management",
            json!("managed"),
        ),
        (
            include_str!("../../../examples/spark/vllm.yaml"),
            "/spec/services/qwen",
            "storage",
            json!({"management":"managed"}),
        ),
        (
            include_str!("../../../examples/spark/vllm.yaml"),
            "/spec/services/qwen/model",
            "management",
            json!("managed"),
        ),
        (
            include_str!("../../../examples/spark/remote-vllm.yaml"),
            "/spec/services/qwen/placement",
            "network",
            json!({"management":"managed"}),
        ),
    ] {
        let mut value = input(source);
        let document = parse(&value).unwrap();
        assert!(schema.is_valid(&value));
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
        value.pointer_mut(parent).unwrap()[field] = declaration;
        assert!(
            parse(&value).is_err(),
            "{parent}/{field} must not restate ownership"
        );
        assert!(!schema.is_valid(&value), "{parent}/{field}");
    }
}

#[test]
fn external_proxy_is_a_connection_not_an_ownership_choice() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input(include_str!("../../../examples/fabric-openclaw.yaml"));
    value["spec"]["sandboxes"][0]["network"]["proxy"] =
        json!({"host":"proxy.internal","port":3128});
    parse(&value).unwrap();
    for management in ["external", "managed"] {
        value["spec"]["sandboxes"][0]["network"]["proxy"]["management"] = json!(management);
        assert!(parse(&value).is_err());
        assert!(!schema.is_valid(&value));
    }
}

#[test]
fn provider_selects_exactly_one_connection_form() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    let original = input(include_str!("../../../examples/managed-ollama-gpu.yaml"));
    for fields in [
        json!({}),
        json!({"serviceRef":"qwen", "endpoint":"http://127.0.0.1:18888/v1"}),
        json!({"serviceRef":"qwen", "credential":{"env":"UNUSED"}}),
    ] {
        let mut value = original.clone();
        let provider = value["spec"]["inferenceProviders"][0]
            .as_object_mut()
            .unwrap();
        provider.remove("serviceRef");
        provider.extend(fields.as_object().unwrap().clone());
        assert!(parse(&value).is_err());
        assert!(!schema.is_valid(&value));
    }
}
