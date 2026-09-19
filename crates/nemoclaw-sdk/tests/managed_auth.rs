// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile,
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

#[test]
fn bearer_auth_compiles_a_managed_credential_reference_without_a_secret() {
    let mut input: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/spark.yaml")).unwrap();
    input["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    let doc =
        Document::parse(input.to_string().as_bytes()).expect("managed bearer auth must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&input)
    );
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|k| (k.into(), "a".repeat(32)))
    .into();
    let targets = compile::targets(&doc, &generations).unwrap();
    let provider = targets
        .iter()
        .find(|t| t.address == "nemoclaw_provider.inference_qwen")
        .unwrap();
    let profile = targets
        .iter()
        .find(|t| t.address == "nemoclaw_provider_profile.inference_qwen")
        .unwrap();
    assert_eq!(profile.values["authenticated"], "true");
    let source: Value = serde_json::from_str(&provider.values["credential_source"]).unwrap();
    assert_eq!(source["kind"], "managedService");
    assert_eq!(source["storage"]["Owner"], doc.metadata.uid);
    assert_eq!(source["endpoint"], provider.values["endpoint"]);
    assert_eq!(
        source["container"],
        format!("{}-inference-qwen", doc.workspace())
    );
    assert!(source.get("spec").is_none());
    assert!(provider.values["credential_env"].is_empty());
    assert!(doc.credential_names().is_empty());
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    input["spec"]["services"]["qwen"]["authentication"] = json!("secret-text");
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
    assert!(
        !jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&input)
    );
}

#[test]
fn runtime_preserves_literal_recipe_environment_without_copying_it_into_credentials() {
    let mut input: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/spark.yaml")).unwrap();
    input["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    input["spec"]["services"]["qwen"]["recipe"]["serving"]["environment"]["VLLM_LITERAL"] =
        json!("${literal.value} %{if untouched}");
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|k| (k.into(), "a".repeat(32)))
    .into();
    let graph = compile::compile(&doc, &generations, "0.1.0").unwrap();
    let runtime = compile::compile_runtime(&doc, &generations, "0.1.0").unwrap();
    let credential = graph["resource"]["nemoclaw_provider"]["inference_qwen"]["credential_source"]
        .as_str()
        .unwrap();
    assert!(!credential.contains("VLLM_LITERAL"));
    let environment =
        runtime["resource"]["docker_container"]["inference_service_inference_qwen"]["env"]
            .as_array()
            .unwrap();
    let value = environment
        .iter()
        .find(|value| value.as_str().unwrap().contains("VLLM_LITERAL"))
        .unwrap();
    assert!(
        value
            .as_str()
            .unwrap()
            .contains("$${literal.value} %%{if untouched}")
    );
}
