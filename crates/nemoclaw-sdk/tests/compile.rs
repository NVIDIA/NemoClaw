// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{compile::compile, config::Document};
use std::collections::BTreeMap;

#[test]
fn gateway_capabilities_gate_deployment_and_follow_bootstrap_reconciliation() {
    use nemoclaw_sdk::compile::compile_runtime;
    let document = Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    assert_eq!(
        graph["data"]["nemoclaw_gateway_capabilities"]["current"]["required_compute_drivers"],
        serde_json::json!(["docker"])
    );
    for resources in graph["resource"].as_object().unwrap().values() {
        for resource in resources.as_object().unwrap().values() {
            assert_eq!(
                resource["lifecycle"]["precondition"][0]["condition"],
                "${data.nemoclaw_gateway_capabilities.current.compatible}"
            );
        }
    }
    let bootstrap = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert_eq!(
        bootstrap["data"]["nemoclaw_gateway_capabilities"]["current"]["depends_on"],
        serde_json::json!(["docker_container.managed_gateway_runtime"]),
        "bootstrap must reconcile its gateway before observing readiness"
    );
}

#[test]
fn image_pull_policy_reaches_the_engine_without_changing_runtime_identity() {
    use nemoclaw_sdk::{
        compile::{compile_runtime, runtime_targets},
        config::ImagePullPolicy,
    };
    let generations = [
        ("workspace", "workspace-generation"),
        ("provider", "provider-generation"),
        ("sandbox", "sandbox-generation"),
        ("ollama", "ollama-generation"),
        ("ollama_service", "ollama-generation"),
        ("managed_gateway", "gateway-generation"),
        ("inference_service", "inference-generation"),
    ]
    .map(|(key, _)| (key.into(), "a".repeat(32)))
    .into();
    let mut document =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let before = compile_runtime(&document, &generations, "0.1.0").unwrap();
    document
        .spec
        .gateway
        .as_managed_mut()
        .unwrap()
        .image_pull_policy = Some(ImagePullPolicy::IfNotPresent);
    let nemoclaw_sdk::services::ServiceDefinition::Vllm(service) =
        document.spec.services.values_mut().next().unwrap()
    else {
        panic!("expected vllm")
    };
    service.image_pull_policy = Some(ImagePullPolicy::IfNotPresent);
    assert_eq!(
        runtime_targets(&document, &generations)
            .unwrap()
            .iter()
            .find(|target| target.kind == "inference_service")
            .unwrap()
            .values["image_pull_policy"],
        "IfNotPresent"
    );
    let after = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert_eq!(after, before);

    let mut document =
        Document::parse(include_str!("fixtures/config/managed-ollama.yaml").as_bytes()).unwrap();
    let before = compile_runtime(&document, &generations, "0.1.0").unwrap();
    let nemoclaw_sdk::services::ServiceDefinition::Ollama(service) =
        document.spec.services.values_mut().next().unwrap()
    else {
        panic!("expected ollama")
    };
    service.image_pull_policy = Some(ImagePullPolicy::Never);
    let after = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert_eq!(
        after["resource"]["docker_image"].as_object().unwrap().len(),
        1
    );
    assert_eq!(after["data"]["docker_image"].as_object().unwrap().len(), 1);
    let mut before_container =
        before["resource"]["docker_container"]["ollama_service_ollama-server"].clone();
    let mut after_container =
        after["resource"]["docker_container"]["ollama_service_ollama-server"].clone();
    assert!(
        before_container["image"]
            .as_str()
            .unwrap()
            .starts_with("${docker_image.")
    );
    assert!(
        after_container["image"]
            .as_str()
            .unwrap()
            .starts_with("${data.docker_image.")
    );
    before_container.as_object_mut().unwrap().remove("image");
    after_container.as_object_mut().unwrap().remove("image");
    assert_eq!(before_container, after_container);
    assert_eq!(
        before["resource"]["nemoclaw_ollama_service_storage"],
        after["resource"]["nemoclaw_ollama_service_storage"]
    );
}

fn ownership_generations() -> BTreeMap<String, String> {
    [("workspace", "a"), ("provider", "b"), ("sandbox", "c")]
        .map(|(kind, token)| (kind.into(), token.repeat(32)))
        .into()
}

#[test]
fn compiled_resources_preserve_ownership_connections_and_dependency_order() {
    use nemoclaw_sdk::config::{Credential, TLS};
    use serde_json::json;
    let mut document =
        Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    *document.spec.gateway.endpoint_mut() = "https://gateway.example.test".into();
    let nemoclaw_sdk::config::Gateway::External(gateway) = &mut document.spec.gateway else {
        panic!("expected external gateway");
    };
    gateway.credential = Some(Credential {
        env: "GATEWAY_TOKEN".into(),
    });
    gateway.tls = Some(TLS {
        ca: Credential {
            env: "GATEWAY_CA".into(),
        },
        certificate: Credential {
            env: "GATEWAY_CERT".into(),
        },
        key: Credential {
            env: "GATEWAY_KEY".into(),
        },
    });
    let provider = &mut document.spec.inference_providers[0];
    provider.name = "remote".into();
    provider.endpoint = "https://models.example.test/v1".into();
    provider.credential = Some(Credential {
        env: "MODEL_TOKEN".into(),
    });
    let sandbox = &mut document.spec.sandboxes[0];
    sandbox.name = "worker".into();
    sandbox.agent.inference.as_mut().unwrap().routes[0].provider_ref = Some("remote".into());
    let generations = ownership_generations();
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    let connection = &graph["provider"]["nemoclaw"];
    for (field, expected) in [
        ("endpoint", "https://gateway.example.test"),
        ("credential_env", "GATEWAY_TOKEN"),
        ("tls_ca_env", "GATEWAY_CA"),
        ("tls_certificate_env", "GATEWAY_CERT"),
        ("tls_key_env", "GATEWAY_KEY"),
    ] {
        assert_eq!(connection[field], expected, "{field}");
    }
    let resources = &graph["resource"];
    let workspace = &resources["nemoclaw_workspace"]["deployment"];
    let provider = &resources["nemoclaw_provider"]["inference_remote"];
    let profile = &resources["nemoclaw_provider_profile"]["inference_remote"];
    let sandbox = &resources["nemoclaw_sandbox"]["worker"];
    assert_eq!(workspace["name"], document.workspace());
    for (resource, generation) in [
        (workspace, "workspace"),
        (provider, "provider"),
        (profile, "provider"),
        (sandbox, "sandbox"),
    ] {
        assert_eq!(resource["owner"], document.metadata.uid);
        assert_eq!(resource["generation"], generations[generation]);
        if generation == "provider" {
            assert!(resource["lifecycle"].get("prevent_destroy").is_none());
        } else {
            assert_eq!(resource["lifecycle"]["prevent_destroy"], true);
        }
    }
    assert_eq!(provider["credential_env"], "MODEL_TOKEN");
    assert_eq!(provider["endpoint"], "https://models.example.test/v1");
    assert_eq!(profile["authenticated"], "true");
    assert!(
        provider["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!("nemoclaw_provider_profile.inference_remote"))
    );
    assert!(
        sandbox["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!("nemoclaw_provider.inference_remote"))
    );
    for resource in [provider, profile, sandbox] {
        assert_eq!(
            resource["workspace"],
            "${nemoclaw_workspace.deployment.name}"
        );
    }
}

#[test]
fn missing_ownership_generations_stop_compilation() {
    let document = Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    for missing in ["workspace", "provider", "sandbox"] {
        let mut generations = ownership_generations();
        generations.remove(missing);
        assert!(
            compile(&document, &generations, "0.1.0").is_err(),
            "{missing}"
        );
    }
}

#[test]
fn managed_plans_query_selected_engine_and_image_without_probe_resources() {
    let document =
        Document::parse(include_str!("../../../examples/onboarding/openclaw.yaml").as_bytes())
            .unwrap();
    let generations = ["workspace", "provider", "sandbox", "managed_gateway"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    for graph in [
        compile(&document, &generations, "0.1.0").unwrap(),
        nemoclaw_sdk::compile::compile_runtime(&document, &generations, "0.1.0").unwrap(),
    ] {
        let engine = &graph["data"]["nemoclaw_engine_capabilities"]["current"];
        assert_eq!(
            engine["engine"],
            document.spec.gateway.as_managed().unwrap().engine
        );
        assert_eq!(engine["compute_driver"], "docker");
        assert!(
            engine.get("depends_on").is_none(),
            "read existing capabilities during plan"
        );
        let image = &graph["data"]["nemoclaw_fabric_capabilities"]["sandbox_0"];
        assert_eq!(image["image"], document.spec.sandboxes[0].image.ref_);
        assert!(
            image.get("depends_on").is_none(),
            "metadata inspection must not depend on image acquisition"
        );
        assert!(
            image["lifecycle"]["postcondition"][0]["condition"]
                .as_str()
                .unwrap()
                .contains("compatibility_status")
        );
        let requirements: serde_json::Value =
            serde_json::from_str(image["requirements_json"].as_str().unwrap()).unwrap();
        assert_eq!(requirements["harness"], "openclaw");
        assert_eq!(requirements["api"], "openai-completions");
        assert!(graph["output"]["discovery"]["value"].is_object());
    }
}

#[test]
fn arbitrary_fabric_harness_identifier_survives_runtime_compilation() {
    let yaml = include_str!("fixtures/config/local.yaml")
        .replace("kind: openclaw", "kind: fixture-custom-adapter\n        settings:\n          custom_option: fixture-value")
        .replace("provider: openai", "provider: openai\n      api: openai-responses");
    let document = Document::parse(yaml.as_bytes()).unwrap();
    let targets = nemoclaw_sdk::compile::targets(&document, &ownership_generations()).unwrap();
    let sandbox = targets
        .iter()
        .find(|target| target.kind == "sandbox")
        .unwrap();
    assert_eq!(
        sandbox.values["agent_runtime"],
        "fabric-fixture-custom-adapter"
    );
    let settings: serde_json::Value =
        serde_json::from_str(&sandbox.values["inference_json"]).unwrap();
    assert!(settings.to_string().contains("openai-responses"));
    assert_eq!(settings["settings"]["custom_option"], "fixture-value");
    let graph = compile(&document, &ownership_generations(), "0.1.0").unwrap();
    assert_eq!(
        graph["resource"]["nemoclaw_sandbox"]["assistant"]["agent_runtime"],
        "fabric-fixture-custom-adapter"
    );
}
