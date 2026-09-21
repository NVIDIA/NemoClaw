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
        "image":format!("nc-ollama-proxy@sha256:{}","a".repeat(64)),
        "endpoint":"http://172.20.0.1:11435/v1",
        "upstream":{"endpoint":"http://127.0.0.1:11434/v1",
            "model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}
    }});
    value
}

#[test]
fn explicit_proxy_engine_works_with_an_external_gateway() {
    let mut value = input();
    value["spec"]["gateway"] =
        json!({"management":"external", "endpoint":"http://127.0.0.1:17671"});
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("podman");
    value["spec"]["services"]["ollama-auth"]["engine"] = json!("unix:///tmp/proxy-engine.sock");
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert!(document.spec.gateway.as_managed().is_none());
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    let generations: Generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let targets = nemoclaw_sdk::compile::targets(&document, &generations).unwrap();
    let proxy_targets: Vec<_> = targets
        .iter()
        .filter(|target| {
            matches!(
                target.kind.as_str(),
                "ollama_proxy" | "ollama_proxy_storage" | "ollama_external_model"
            )
        })
        .collect();
    assert_eq!(proxy_targets.len(), 3);
    for target in proxy_targets {
        assert_eq!(target.values["engine"], "unix:///tmp/proxy-engine.sock");
    }
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    let credential: Value = serde_json::from_str(
        graph["resource"]["nemoclaw_provider"]["inference_local"]["credential_source"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        credential["storage"]["Engine"],
        "unix:///tmp/proxy-engine.sock"
    );
}

#[test]
fn explicit_proxy_engine_must_be_a_valid_local_socket() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for engine in [
        "",
        "ssh://operator@host",
        "tcp://127.0.0.1:2375",
        "unix://relative",
        "unix:///tmp/socket?query",
        "unix:///tmp/socket#fragment",
    ] {
        let mut value = input();
        value["spec"]["services"]["ollama-auth"]["engine"] = json!(engine);
        let error = Document::parse(value.to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("proxy engine must be a local Unix socket"),
            "{engine}: {error}"
        );
        assert!(!validator.is_valid(&value));
    }
}
#[test]
fn proxy_pull_policy_preserves_credentials_and_other_resource_settings() {
    let gens: Generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let mut value = input();
    let original = Document::parse(value.to_string().as_bytes()).unwrap();
    let before = compile(&original, &gens, "0.1.0").unwrap();
    for policy in ["IfNotPresent", "Never"] {
        value["spec"]["services"]["ollama-auth"]["imagePullPolicy"] = json!(policy);
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
        let after = compile(&document, &gens, "0.1.0").unwrap();
        for kind in [
            "nemoclaw_ollama_proxy_storage",
            "nemoclaw_ollama_external_model",
        ] {
            assert_eq!(after["resource"][kind], before["resource"][kind]);
        }
        if policy == "IfNotPresent" {
            assert_eq!(after, before);
        } else {
            let mut changed = after["resource"]["docker_container"].clone();
            let mut original = before["resource"]["docker_container"].clone();
            assert!(
                changed["ollama_proxy_ollama-auth"]["image"]
                    .as_str()
                    .unwrap()
                    .starts_with("${data.docker_image.")
            );
            changed["ollama_proxy_ollama-auth"]
                .as_object_mut()
                .unwrap()
                .remove("image");
            original["ollama_proxy_ollama-auth"]
                .as_object_mut()
                .unwrap()
                .remove("image");
            assert_eq!(changed, original);
            assert_eq!(
                after["resource"]["nemoclaw_provider"],
                before["resource"]["nemoclaw_provider"]
            );
            assert_eq!(
                after["resource"]["nemoclaw_ollama_proxy_storage"],
                before["resource"]["nemoclaw_ollama_proxy_storage"]
            );
        }
    }
}

#[test]
fn proxy_rejects_always_pull_with_supported_alternatives() {
    let mut value = input();
    value["spec"]["services"]["ollama-auth"]["imagePullPolicy"] = json!("Always");
    let error = Document::parse(value.to_string().as_bytes())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("IfNotPresent") && error.contains("Never"),
        "{error}"
    );
    assert!(
        !jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
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
    assert!(resources["docker_container"]["ollama_proxy_ollama-auth"].is_object());
    assert!(resources["nemoclaw_ollama_external_model"]["ollama-auth"].is_object());
    assert_eq!(
        resources["nemoclaw_provider_profile"]["inference_local"]["authenticated"],
        "true"
    );
    assert_eq!(
        resources["nemoclaw_provider"]["inference_local"]["depends_on"],
        json!([
            "nemoclaw_provider_profile.inference_local",
            "docker_container.ollama_proxy_ollama-auth"
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
        assert!(graph["resource"]["docker_container"]["ollama_proxy_ollama-auth"].is_object());
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
    for (kind, first, second) in [
        (
            "docker_container",
            "ollama_proxy_ollama-auth",
            "ollama_proxy_second",
        ),
        ("nemoclaw_ollama_proxy_storage", "ollama-auth", "second"),
    ] {
        assert_ne!(
            graph["resource"][kind][first]["name"],
            graph["resource"][kind][second]["name"]
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

#[test]
fn proxy_requires_a_managed_docker_gateway_and_uses_its_engine() {
    let mut value = input();
    value["spec"]["gateway"]["engine"] = json!("unix:///tmp/proxy-engine.sock");
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations = ["workspace", "provider", "sandbox", "ollama_proxy"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let graph = compile(&document, &generations, "test").unwrap();
    assert_eq!(
        graph["provider"]["docker"][0]["host"],
        "unix:///tmp/proxy-engine.sock"
    );
    for kind in [
        "nemoclaw_ollama_proxy_storage",
        "nemoclaw_ollama_external_model",
    ] {
        assert_eq!(
            graph["resource"][kind]["ollama-auth"]["engine"],
            "unix:///tmp/proxy-engine.sock"
        );
    }
    let mut external = value.clone();
    external["spec"]["gateway"] =
        json!({"management":"external", "endpoint":"http://127.0.0.1:17671"});
    assert!(
        Document::parse(external.to_string().as_bytes())
            .unwrap_err()
            .to_string()
            .contains("managed local Docker gateway")
    );
    value["spec"]["sandboxes"][0]["runtime"]["provider"] = json!("podman");
    assert!(
        Document::parse(value.to_string().as_bytes())
            .unwrap_err()
            .to_string()
            .contains("managed local Docker gateway")
    );
}

#[test]
fn proxy_compute_changes_do_not_replace_credential_storage_or_external_model_observation() {
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "ollama_proxy",
        "managed_gateway",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    let auxiliary = |value: &Value| {
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        nemoclaw_sdk::compile::targets(&document, &generations)
            .unwrap()
            .into_iter()
            .filter(|target| {
                matches!(
                    target.kind.as_str(),
                    "ollama_proxy_storage" | "ollama_external_model"
                )
            })
            .collect::<Vec<_>>()
    };
    let mut value = input();
    let before = auxiliary(&value);
    value["spec"]["services"]["ollama-auth"]["image"] =
        json!(format!("replacement@sha256:{}", "b".repeat(64)));
    value["spec"]["services"]["ollama-auth"]["imagePullPolicy"] = json!("Never");
    value["spec"]["services"]["ollama-auth"]["endpoint"] = json!("http://172.20.0.1:11436/v1");
    assert_eq!(auxiliary(&value), before);
    for schema in nemoclaw_sdk::services::resource_schemas()
        .into_iter()
        .filter(|schema| {
            matches!(
                schema.kind,
                "ollama_proxy_storage" | "ollama_external_model"
            )
        })
    {
        for field in ["image", "image_pull_policy", "bind_address"] {
            assert!(
                !schema.fields.contains(&field),
                "{} still owns {field}",
                schema.kind
            );
        }
    }
}
