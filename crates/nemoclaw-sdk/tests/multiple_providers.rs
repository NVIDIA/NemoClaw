// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile, runtime_targets, targets},
    config::{Document, schema::input_schema},
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
    .map(|key| (key.into(), "a".repeat(32)))
    .into()
}
fn oracle(mut value: Value) -> Value {
    value["spec"]["inferenceProviders"].as_array_mut().unwrap().push(json!({"name":"oracle","provider":"anthropic","api":"anthropic-messages","endpoint":"https://oracle.example/v1","credential":{"env":"ORACLE_KEY"}}));
    let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
    inference["default"] = json!("smart");
    inference["routes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"smart","providerRef":"oracle","overrides":{"model":"smart-model"}}));
    value
}
#[test]
fn a_sandbox_attaches_the_union_of_selected_providers_with_bound_credentials() {
    let input: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    let mut value = oracle(input);
    let mut other = value["spec"]["sandboxes"][0].clone();
    other["name"] = json!("other");
    other["agent"]["inference"]["routes"]
        .as_array_mut()
        .unwrap()
        .pop();
    other["agent"]["inference"]
        .as_object_mut()
        .unwrap()
        .remove("default");
    value["spec"]["sandboxes"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let doc = Document::parse(value.to_string().as_bytes()).expect("local and oracle providers");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert_eq!(doc.credential_names(), vec!["ORACLE_KEY"]);
    let rows = targets(&doc, &generations()).unwrap();
    assert_eq!(rows.iter().filter(|row| row.kind == "provider").count(), 2);
    assert_eq!(
        rows.iter()
            .filter(|row| row.kind == "provider_profile")
            .count(),
        2
    );
    let sandbox = rows.iter().find(|row| row.kind == "sandbox").unwrap();
    let settings: Value = serde_json::from_str(&sandbox.values["inference_json"]).unwrap();
    assert_eq!(settings["provider"], "oracle");
    assert_eq!(
        settings["agents"][0]["inference"]["models"]["smart"]["connection"]["api_key_env"],
        "NEMOCLAW_INFERENCE_ORACLE_KEY"
    );
    let other = rows
        .iter()
        .find(|row| row.kind == "sandbox" && row.values["name"] == "other")
        .unwrap();
    let other_settings: Value = serde_json::from_str(&other.values["inference_json"]).unwrap();
    assert_eq!(
        other_settings["agents"][0]["inference"]["models"]["primary"]["connection"]["api_key_env"],
        "NEMOCLAW_ANONYMOUS_API_KEY"
    );
    assert!(other_settings["agents"][0]["inference"]["models"]["smart"].is_null());
    let other_policy: Value = serde_json::from_str(&other.values["policy_json"]).unwrap();
    assert_eq!(
        other_policy["network_policies"].as_object().unwrap().len(),
        1
    );
    let policy: Value = serde_json::from_str(&sandbox.values["policy_json"]).unwrap();
    assert_eq!(policy["network_policies"].as_object().unwrap().len(), 2);
    let graph = compile(&doc, &generations(), "0.1.0").unwrap();
    assert_eq!(
        graph["resource"]["nemoclaw_sandbox"]["assistant"]["depends_on"]
            .as_array()
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
fn managed_inference_remains_owned_when_the_default_uses_an_external_oracle() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    let local_name = value["spec"]["inferenceProviders"][0]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    let doc = Document::parse(oracle(value).to_string().as_bytes())
        .expect("managed local model plus external default");
    let runtime = runtime_targets(&doc, &generations()).unwrap();
    assert!(runtime.iter().any(|row| row.kind == "inference_service"));
    let rows = targets(&doc, &generations()).unwrap();
    assert_eq!(rows.iter().filter(|row| row.kind == "provider").count(), 2);
    assert!(
        rows.iter()
            .find(|row| row.kind == "provider" && row.values["name"] == local_name)
            .unwrap()
            .values
            .contains_key("credential_source")
    );
    assert!(
        !rows
            .iter()
            .find(|row| row.kind == "provider" && row.values["name"] == "oracle")
            .unwrap()
            .values
            .contains_key("credential_source")
    );
}

#[test]
fn managed_ollama_keeps_its_model_and_provider_dependency_with_an_external_default() {
    let value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/managed-ollama.yaml")).unwrap();
    let model =
        value["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["model"]
            .clone();
    let local_name = value["spec"]["inferenceProviders"][0]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = Document::parse(oracle(value).to_string().as_bytes()).unwrap();
    let graph = compile(&doc, &generations(), "0.1.0").unwrap();
    assert_eq!(
        graph["resource"]["nemoclaw_ollama_model"]["ollama-server"]["model"],
        model
    );
    let dependencies =
        graph["resource"]["nemoclaw_provider"][format!("inference_{local_name}")]["depends_on"]
            .as_array()
            .unwrap();
    assert!(dependencies.contains(&json!("nemoclaw_ollama_model.ollama-server")));
    assert!(
        !graph["resource"]["nemoclaw_provider"]["inference_oracle"]["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!("nemoclaw_ollama_model.ollama-server"))
    );
}

#[test]
fn multiple_selected_ollama_installers_have_independent_resources_and_dependencies() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/managed-ollama.yaml")).unwrap();
    let mut other = value["spec"]["inferenceProviders"][0].clone();
    other["name"] = json!("other");
    other["serviceRef"] = json!("other");
    let mut other_service = value["spec"]["services"]["ollama-server"].clone();
    other_service["endpoint"] = json!("http://172.20.0.1:11437/v1");
    value["spec"]["services"]["other"] = other_service;
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
    inference["default"] = json!("primary");
    let mut route = inference["routes"][0].clone();
    route["name"] = json!("other");
    route["providerRef"] = json!("other");
    inference["routes"].as_array_mut().unwrap().push(route);
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    for (provider, service) in [("local", "ollama-server"), ("other", "other")] {
        assert!(graph["resource"]["nemoclaw_ollama"][service].is_object());
        assert!(graph["resource"]["nemoclaw_ollama_storage"][service].is_object());
        assert!(graph["resource"]["nemoclaw_ollama_model"][service].is_object());
        assert!(
            graph["resource"]["nemoclaw_provider"][format!("inference_{provider}")]["depends_on"]
                .as_array()
                .unwrap()
                .contains(&json!(format!("nemoclaw_ollama_model.{service}")))
        );
    }
}

#[test]
fn managed_services_have_independent_storage_credentials_and_dependencies() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    let first = value["spec"]["inferenceProviders"][0]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    let mut other = value["spec"]["inferenceProviders"][0].clone();
    other["name"] = json!("other");
    other["serviceRef"] = json!("other");
    let mut other_service = value["spec"]["services"]["qwen"].clone();
    other_service["serving"]["port"] = json!(18999);
    value["spec"]["services"]["other"] = other_service;
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(other);
    let inference = &mut value["spec"]["sandboxes"][0]["agent"]["inference"];
    inference["default"] = json!("primary");
    let mut route = inference["routes"][0].clone();
    route["name"] = json!("other");
    route["providerRef"] = json!("other");
    inference["routes"].as_array_mut().unwrap().push(route);
    let doc = Document::parse(value.to_string().as_bytes()).expect("two managed services");
    let runtime = runtime_targets(&doc, &generations()).unwrap();
    let services: Vec<_> = runtime
        .iter()
        .filter(|t| t.kind == "inference_service")
        .collect();
    assert_eq!(services.len(), 2);
    assert_ne!(services[0].address, services[1].address);
    let graph = nemoclaw_sdk::compile::compile_runtime(&doc, &generations(), "0.1.0").unwrap();
    let rows = targets(&doc, &generations()).unwrap();
    for name in [&first, "other"] {
        let address = format!("nemoclaw_inference_service.inference_{name}");
        let service = runtime.iter().find(|t| t.address == address).unwrap();
        let spec: Value = serde_json::from_str(&service.values["spec"]).unwrap();
        let credentials: Value = serde_json::from_str(
            &rows
                .iter()
                .find(|t| t.kind == "provider" && t.values["name"] == name)
                .unwrap()
                .values["credential_source"],
        )
        .unwrap();
        assert_eq!(credentials["spec"], spec);
        let dependencies = graph["resource"]["nemoclaw_inference_service"]
            [format!("inference_{name}")]["depends_on"]
            .as_array()
            .unwrap();
        assert!(dependencies.contains(&json!(format!(
            "nemoclaw_inference_storage.inference_{name}"
        ))));
    }
    // Duplicate bind ports must fail before creating either service.
    value["spec"]["services"]["other"]["serving"]["port"] =
        value["spec"]["services"]["qwen"]["serving"]["port"].clone();
    assert!(
        Document::parse(value.to_string().as_bytes())
            .unwrap_err()
            .to_string()
            .contains("publication")
    );
}
