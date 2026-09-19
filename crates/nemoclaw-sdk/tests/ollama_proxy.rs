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
    provider["serviceRef"] = json!("ollama-auth");
    value["spec"]["services"] = json!({"ollama-auth": {
        "kind":"ollamaProxy",
        "runtime":{"provider":"docker","engine":"unix:///var/run/docker.sock",
            "image":format!("nc-ollama-proxy@sha256:{}","a".repeat(64))},
        "endpoint":"http://172.20.0.1:11435/v1",
        "upstream":{"endpoint":"http://127.0.0.1:11434/v1",
            "model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}
    }});
    value
}
#[test]
fn proxy_pull_policy_preserves_credentials_and_other_resource_settings() {
    let gens: Generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let mut value = input();
    let original = Document::parse(value.to_string().as_bytes()).unwrap();
    let before = compile(&original, &gens, "0.1.0").unwrap();
    for policy in ["Always", "IfNotPresent", "Never"] {
        value["spec"]["services"]["ollama-auth"]["runtime"]["imagePullPolicy"] = json!(policy);
        assert!(
            jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
        let mut after = compile(&document, &gens, "0.1.0").unwrap();
        for (kind, name) in [
            ("nemoclaw_ollama_proxy", "ollama-auth"),
            ("nemoclaw_ollama_proxy_storage", "ollama-auth"),
            ("nemoclaw_ollama_external_model", "ollama-auth"),
        ] {
            assert_eq!(
                after["resource"][kind][name]
                    .as_object_mut()
                    .unwrap()
                    .remove("image_pull_policy")
                    .unwrap(),
                policy
            );
        }
        assert_eq!(after, before);
    }
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
    let gens: Generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let graph = compile(&doc, &gens, "0.1.0").unwrap();
    let resources = &graph["resource"];
    assert!(resources.get("nemoclaw_ollama").is_none());
    assert!(resources["nemoclaw_ollama_proxy"]["ollama-auth"].is_object());
    assert!(resources["nemoclaw_ollama_external_model"]["ollama-auth"].is_object());
    assert_eq!(
        resources["nemoclaw_provider_profile"]["inference_local"]["authenticated"],
        "true"
    );
    assert_eq!(
        resources["nemoclaw_provider"]["inference_local"]["depends_on"],
        json!([
            "nemoclaw_provider_profile.inference_local",
            "nemoclaw_ollama_proxy.ollama-auth"
        ])
    );
    assert!(
        !resources["nemoclaw_provider"]["inference_local"]["credential_source"]
            .as_str()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn proxy_rejects_unpinned_models_nonlocal_daemons_and_ambiguous_ownership() {
    for (field, bad) in [
        ("endpoint", json!("http://172.20.0.1:11434/v1")),
        ("management", json!("external")),
        ("credential", json!({"env":"API_KEY"})),
    ] {
        let mut value = input();
        value["spec"]["inferenceProviders"][0][field] = bad;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for (path, ownership) in [
        ("/spec/services/ollama-auth", "managed"),
        ("/spec/services/ollama-auth/upstream/model", "external"),
    ] {
        let mut value = input();
        value.pointer_mut(path).unwrap()["management"] = json!(ownership);
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!schema.is_valid(&value));
    }
    let mut value = input();
    value["spec"]["services"]["ollama-auth"]["upstream"]["model"]["digest"] = json!("latest");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}

#[test]
fn deep_agents_and_pi_use_authenticated_ollama_proxy_connections() {
    for harness in ["deepagents", "pi"] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["harness"]["kind"] = json!(harness);
        let doc = Document::parse(value.to_string().as_bytes()).unwrap();
        assert!(
            jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
        let gens: Generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
            .map(|k| (k.into(), "a".repeat(32)))
            .into();
        let graph = compile(&doc, &gens, "0.1.0").unwrap();
        assert!(graph["resource"]["nemoclaw_ollama_proxy"]["ollama-auth"].is_object());
        assert!(
            !graph["resource"]["nemoclaw_provider"]["inference_local"]["credential_source"]
                .as_str()
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn named_proxies_have_distinct_containers_storage_and_credentials() {
    let mut value = input();
    let mut second = value["spec"]["services"]["ollama-auth"].clone();
    second["endpoint"] = json!("http://172.20.0.1:11436/v1");
    value["spec"]["services"]["second"] = second;
    let mut provider = value["spec"]["inferenceProviders"][0].clone();
    provider["name"] = json!("second");
    provider["serviceRef"] = json!("second");
    value["spec"]["inferenceProviders"]
        .as_array_mut()
        .unwrap()
        .push(provider);
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let gens: Generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let graph = compile(&doc, &gens, "0.1.0").unwrap();
    for kind in ["nemoclaw_ollama_proxy", "nemoclaw_ollama_proxy_storage"] {
        assert_ne!(
            graph["resource"][kind]["ollama-auth"]["name"],
            graph["resource"][kind]["second"]["name"]
        );
    }
    let first = serde_json::to_value(&doc).unwrap();
    let mut changed = first;
    changed["spec"]["inferenceProviders"][0]["serviceRef"] = json!("second");
    let doc = Document::parse(changed.to_string().as_bytes()).unwrap();
    let other = compile(&doc, &gens, "0.1.0").unwrap();
    assert_ne!(
        graph["resource"]["nemoclaw_provider"]["inference_local"]["credential_source"],
        other["resource"]["nemoclaw_provider"]["inference_local"]["credential_source"]
    );
}
