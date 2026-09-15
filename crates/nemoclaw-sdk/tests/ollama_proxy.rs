// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};
fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/managed-ollama.yaml")).unwrap();
    let provider = &mut value["spec"]["inferenceProviders"][0];
    provider.as_object_mut().unwrap().remove("ollama");
    provider["management"] = json!("external");
    provider["endpoint"] = json!("http://127.0.0.1:11434/v1");
    provider["ollamaProxy"] = json!({"engine":"unix:///var/run/docker.sock",
        "image":format!("nc-ollama-proxy@sha256:{}","a".repeat(64)),"endpoint":"http://172.20.0.1:11435/v1",
        "model":{"digest":"a".repeat(64)}});
    value
}
#[test]
fn external_ollama_compiles_only_proxy_and_external_model_observation() {
    let value = input();
    let doc =
        Document::parse(value.to_string().as_bytes()).expect("external Ollama proxy must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    assert_eq!(
        doc.inference_endpoint().unwrap(),
        "http://172.20.0.1:11435/v1"
    );
    assert!(doc.credential_names().is_empty());
    let gens: Generations = ["workspace", "provider", "sandbox", "ollama"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let graph = compile(&doc, &gens, "0.1.0").unwrap();
    let resources = &graph["resource"];
    assert!(resources.get("nemoclaw_ollama").is_none());
    assert!(resources["nemoclaw_ollama_proxy"]["service"].is_object());
    assert!(resources["nemoclaw_ollama_external_model"]["inference"].is_object());
    assert_eq!(
        resources["nemoclaw_provider"]["inference"]["depends_on"],
        json!(["nemoclaw_ollama_proxy.service"])
    );
    assert!(
        !resources["nemoclaw_provider"]["inference"]["credential_source"]
            .as_str()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn proxy_rejects_unpinned_models_nonlocal_daemons_and_ambiguous_ownership() {
    for (field, bad) in [
        ("endpoint", json!("http://172.20.0.1:11434/v1")),
        ("management", json!("managed")),
        ("credential", json!({"env":"API_KEY"})),
    ] {
        let mut value = input();
        value["spec"]["inferenceProviders"][0][field] = bad;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
    let mut value = input();
    value["spec"]["inferenceProviders"][0]["ollamaProxy"]["model"]["digest"] = json!("latest");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
