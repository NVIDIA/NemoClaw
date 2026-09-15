// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/managed-ollama.yaml")).unwrap()
}
fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}
#[test]
fn explicit_external_dependencies_preserve_the_resource_graph() {
    let mut legacy = input();
    legacy["spec"]["sandboxes"][0]["network"]["proxy"] =
        json!({"host":"proxy.internal","port":3128});
    let mut explicit = legacy.clone();
    explicit["spec"]["inferenceProviders"][0]["ollama"]["network"] =
        json!({"management":"external","name":"nc-prototype-slice"});
    explicit["spec"]["sandboxes"][0]["network"]["proxy"]["management"] = json!("external");
    let document = parse(&explicit).expect("external dependencies must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&explicit)
    );
    let generations: Generations = ["workspace", "provider", "sandbox", "ollama"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    assert_eq!(
        compile(&document, &generations, "test").unwrap(),
        compile(&parse(&legacy).unwrap(), &generations, "test").unwrap()
    );
    assert_eq!(
        parse(&serde_saphyr::from_str::<Value>(&document.yaml().unwrap()).unwrap()).unwrap(),
        document
    );
    let yaml = document.yaml().unwrap();
    assert!(yaml.contains("management: external"));
}
#[test]
fn unsupported_management_and_creation_fields_are_rejected() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for network in [
        json!({"management":"managed","name":"shared"}),
        json!({"management":"external","name":"shared","cidr":"172.20.0.0/24"}),
        json!({"management":"external"}),
    ] {
        let mut value = input();
        value["spec"]["inferenceProviders"][0]["ollama"]["network"] = network;
        assert!(parse(&value).is_err());
        assert!(!schema.is_valid(&value));
    }
    let mut value = input();
    value["spec"]["sandboxes"][0]["network"]["proxy"] =
        json!({"management":"managed","host":"proxy.internal","port":3128});
    assert!(parse(&value).is_err());
    assert!(!schema.is_valid(&value));
}

#[test]
fn managed_dependencies_are_optional_and_do_not_replace_existing_resources() {
    let legacy: Value =
        serde_saphyr::from_str(include_str!("../../../examples/vllm.yaml")).unwrap();
    let mut explicit = legacy.clone();
    for path in ["/spec/gateway", "/spec/inferenceProviders/0/service"] {
        let resource = explicit.pointer_mut(path).unwrap();
        resource["storage"] = json!({"management":"managed"});
    }
    explicit["spec"]["gateway"]["network"] = json!({"management":"managed"});
    explicit["spec"]["inferenceProviders"][0]["service"]["management"] = json!("managed");
    explicit["spec"]["inferenceProviders"][0]["service"]["model"]["management"] = json!("managed");
    let document = parse(&explicit).expect("managed declarations must parse");
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(schema.is_valid(&explicit));
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    assert_eq!(
        nemoclaw_sdk::compile::compile_runtime(&document, &generations, "test").unwrap(),
        nemoclaw_sdk::compile::compile_runtime(&parse(&legacy).unwrap(), &generations, "test")
            .unwrap()
    );
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    for path in [
        "/spec/gateway/storage/management",
        "/spec/gateway/network/management",
        "/spec/inferenceProviders/0/service/management",
        "/spec/inferenceProviders/0/service/storage/management",
        "/spec/inferenceProviders/0/service/model/management",
    ] {
        let mut invalid = explicit.clone();
        *invalid.pointer_mut(path).unwrap() = json!("external");
        assert!(parse(&invalid).is_err(), "{path}");
        assert!(!schema.is_valid(&invalid), "{path}");
    }
    let mut external_gateway = input();
    external_gateway["spec"]["gateway"]["storage"] = json!({"management":"managed"});
    assert!(parse(&external_gateway).is_err());
    assert!(!schema.is_valid(&external_gateway));
}

#[test]
fn ollama_storage_and_model_management_preserve_existing_lifecycle() {
    let legacy = input();
    let mut explicit = legacy.clone();
    let ollama = &mut explicit["spec"]["inferenceProviders"][0]["ollama"];
    ollama["management"] = json!("managed");
    ollama["storage"] = json!({"management":"managed"});
    ollama["model"] = json!({"management":"managed"});
    let document = parse(&explicit).expect("Ollama ownership declarations must parse");
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(schema.is_valid(&explicit));
    let generations: Generations = ["workspace", "provider", "sandbox", "ollama"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    assert_eq!(
        compile(&document, &generations, "test").unwrap(),
        compile(&parse(&legacy).unwrap(), &generations, "test").unwrap()
    );
    for path in [
        "/spec/inferenceProviders/0/ollama/management",
        "/spec/inferenceProviders/0/ollama/storage/management",
        "/spec/inferenceProviders/0/ollama/model/management",
    ] {
        let mut invalid = explicit.clone();
        *invalid.pointer_mut(path).unwrap() = json!("external");
        assert!(parse(&invalid).is_err());
        assert!(!schema.is_valid(&invalid));
    }
}
