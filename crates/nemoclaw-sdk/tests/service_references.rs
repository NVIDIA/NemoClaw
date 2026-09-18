// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};

fn managed_ollama_service() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/managed-ollama.yaml")).unwrap();
    value["spec"]["services"]["unused"] = json!({
        "kind": "ollama",
        "management": "managed",
        "runtime": {
            "provider": "docker",
            "engine": "unix:///var/run/docker.sock",
            "image": format!("ollama/ollama@sha256:{}", "b".repeat(64))
        },
        "endpoint": "http://172.20.0.1:11437/v1",
        "network": "nc-prototype-slice",
        "model": {"name": "qwen3:0.6b"}
    });
    value
}

#[test]
fn referenced_services_compile_once_and_unused_definitions_create_nothing() {
    let value = managed_ollama_service();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox", "ollama"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    assert!(graph["resource"]["nemoclaw_ollama"]["ollama-server"].is_object());
    assert!(graph["resource"]["nemoclaw_ollama"].get("unused").is_none());
    assert_eq!(
        document.inference_endpoint().unwrap(),
        "http://172.20.0.1:11436/v1"
    );
}

#[test]
fn service_references_reject_missing_names_and_legacy_inline_installers() {
    let mut missing = managed_ollama_service();
    missing["spec"]["inferenceProviders"][0]["serviceRef"] = json!("missing");
    assert!(Document::parse(missing.to_string().as_bytes()).is_err());

    let mut legacy = managed_ollama_service();
    let inline = legacy["spec"]["services"]
        .as_object_mut()
        .unwrap()
        .remove("ollama-server")
        .unwrap();
    legacy["spec"].as_object_mut().unwrap().remove("services");
    let provider = &mut legacy["spec"]["inferenceProviders"][0];
    provider.as_object_mut().unwrap().remove("serviceRef");
    provider["endpoint"] = inline["endpoint"].clone();
    provider["ollama"] = json!({
        "engine": inline["runtime"]["engine"],
        "image": inline["runtime"]["image"],
        "network": inline["network"]
    });
    assert!(Document::parse(legacy.to_string().as_bytes()).is_err());
}
