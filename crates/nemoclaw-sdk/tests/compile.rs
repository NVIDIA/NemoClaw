// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{compile::compile, config::Document};
use std::collections::BTreeMap;

#[test]
fn gateway_capabilities_gate_deployment_but_do_not_query_during_bootstrap() {
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
    assert!(
        bootstrap["data"]
            .get("nemoclaw_gateway_capabilities")
            .is_none(),
        "bootstrap must not require an already running gateway"
    );
}

#[test]
fn image_pull_policy_reaches_the_engine_without_changing_runtime_identity() {
    use nemoclaw_sdk::{compile::compile_runtime, config::ImagePullPolicy};
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
    document.spec.gateway.image_pull_policy = Some(ImagePullPolicy::Always);
    let nemoclaw_sdk::services::ServiceDefinition::Vllm(service) =
        document.spec.services.values_mut().next().unwrap()
    else {
        panic!("expected vllm")
    };
    service.image_pull_policy = Some(ImagePullPolicy::IfNotPresent);
    let mut after = compile_runtime(&document, &generations, "0.1.0").unwrap();
    for (kind, expected) in [
        ("nemoclaw_managed_gateway", "Always"),
        ("nemoclaw_gateway_storage", "Always"),
        ("nemoclaw_inference_service", "IfNotPresent"),
    ] {
        for resource in after["resource"][kind]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            assert_eq!(
                resource
                    .as_object_mut()
                    .unwrap()
                    .remove("image_pull_policy")
                    .unwrap(),
                expected
            );
        }
    }
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
    let mut after = compile_runtime(&document, &generations, "0.1.0").unwrap();
    assert_eq!(
        after["resource"]["nemoclaw_ollama_service"]["ollama-server"]
            .as_object_mut()
            .unwrap()
            .remove("image_pull_policy")
            .unwrap(),
        "Never"
    );
    assert_eq!(after, before);
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
    document.spec.gateway.endpoint = "https://gateway.example.test".into();
    document.spec.gateway.credential = Some(Credential {
        env: "GATEWAY_TOKEN".into(),
    });
    document.spec.gateway.tls = Some(TLS {
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
        assert_eq!(resource["lifecycle"]["prevent_destroy"], true);
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
