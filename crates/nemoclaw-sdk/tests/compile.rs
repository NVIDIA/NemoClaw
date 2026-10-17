// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::provider_scope;

use nemoclaw_sdk::{compile::compile, config::Document};
use std::collections::BTreeMap;

#[test]
fn gateway_capabilities_gate_deployment_and_follow_bootstrap_reconciliation() {
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
        graph["data"]["openshell_gateway"]["current"]["required_compute_drivers"],
        serde_json::json!(["docker"])
    );
    for (kind, resources) in graph["resource"].as_object().unwrap() {
        if !(kind.starts_with("openshell_") && !kind.contains("gateway")
            || kind.starts_with("fabric_"))
        {
            continue;
        }
        for resource in resources.as_object().unwrap().values() {
            assert_eq!(
                resource["lifecycle"]["precondition"][0]["condition"],
                "${data.openshell_gateway.current.compatible}"
            );
        }
    }
    let apply = &graph["data"]["openshell_gateway"]["apply"]["depends_on"];
    assert!(
        apply.as_array().unwrap().contains(&serde_json::json!(
            "docker_container.managed_gateway_runtime"
        )),
        "objects change only after the gateway they use settles"
    );
    assert_eq!(
        graph["data"]["openshell_gateway"]["current"]["depends_on"],
        serde_json::json!([
            "docker_container.managed_gateway_runtime",
            "data.openshell_docker_gateway_readiness.current"
        ]),
        "bootstrap must reconcile its gateway and wait for its process before observing capabilities"
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
    // Providers take no connection; the gateway data source does, and
    // objects take its ref.
    for provider in ["openshell", "fabric", "host"] {
        assert_eq!(graph["provider"][provider], json!({}), "{provider}");
    }
    assert!(graph["provider"].get("nemoclaw").is_none());
    for read in ["current", "apply"] {
        let connection = &graph["data"]["openshell_gateway"][read];
        for (field, expected) in [
            ("endpoint", "https://gateway.example.test"),
            ("credential_env", "GATEWAY_TOKEN"),
            ("tls_ca_env", "GATEWAY_CA"),
            ("tls_certificate_env", "GATEWAY_CERT"),
            ("tls_key_env", "GATEWAY_KEY"),
        ] {
            assert_eq!(connection[field], expected, "{read}.{field}");
        }
    }
    let resources = &graph["resource"];
    let workspace = &resources["openshell_workspace"]["deployment"];
    let provider = &provider_scope::resource(&resources["openshell_inference"], "remote");
    let sandbox = &resources["openshell_sandbox"]["worker"];
    assert_eq!(workspace["name"], document.workspace());
    for (resource, generation) in [
        (workspace, "workspace"),
        (provider, "provider"),
        (sandbox, "sandbox"),
    ] {
        // An inference provider's owner comes from its workspace ref.
        if generation == "provider" {
            assert!(resource.get("owner").is_none());
        } else {
            assert_eq!(resource["owner"], document.metadata.uid);
        }
        assert_eq!(resource["generation"], generations[generation]);
        // Only the workspace is retained; a sandbox is replaced with its agent.
        if generation == "workspace" {
            assert_eq!(resource["lifecycle"]["prevent_destroy"], true);
        } else {
            assert!(resource["lifecycle"].get("prevent_destroy").is_none());
        }
    }
    // A changed agent configuration replaces the sandbox, through a
    // terraform_data holding the configuration Fabric receives.
    assert_eq!(
        sandbox["lifecycle"]["replace_triggered_by"],
        json!(["terraform_data.agent_worker"])
    );
    let configuration = &resources["terraform_data"]["agent_worker"];
    let input: serde_json::Value =
        serde_json::from_str(configuration["input"].as_str().unwrap()).unwrap();
    assert_eq!(
        input["metadata"]["name"],
        resources["fabric_agent"]["worker"]["name"]
    );
    assert_eq!(
        configuration["depends_on"],
        json!(["data.openshell_gateway.apply"])
    );
    assert!(configuration.get("lifecycle").is_none());
    assert_eq!(provider["server"]["credential_env"], "MODEL_TOKEN");
    assert_eq!(
        provider["server"]["endpoint"],
        "https://models.example.test/v1"
    );
    assert!(
        sandbox["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!(provider_scope::address(
                &resources["openshell_inference"],
                "inference",
                "remote"
            )))
    );
    for resource in [provider, sandbox] {
        assert_eq!(
            resource["workspace"],
            "${openshell_workspace.deployment.ref}"
        );
    }
    // Objects take a literal gateway ref, known while planning, equal to
    // what the gateway data source exports; that read gates the resources.
    let read = &graph["data"]["openshell_gateway"]["current"];
    for resource in [
        workspace,
        provider,
        sandbox,
        &resources["fabric_agent"]["worker"],
    ] {
        assert!(
            resource["depends_on"].as_array().is_some_and(
                |dependencies| dependencies.contains(&json!("data.openshell_gateway.apply"))
            ),
            "the gateway read gates {resource}"
        );
    }
    for resource in [
        workspace,
        provider,
        sandbox,
        &resources["fabric_agent"]["worker"],
    ] {
        assert_eq!(
            resource["gateway"]["type"], "openshell_gateway",
            "{resource}"
        );
        for (attribute, _) in nemoclaw_openshell::GATEWAY_FIELDS {
            assert_eq!(
                resource["gateway"][attribute],
                read.get(attribute).cloned().unwrap_or(json!("")),
                "{attribute}: {resource}"
            );
        }
        for field in [
            "gateway_endpoint",
            "gateway_credential_env",
            "gateway_tls_ca_env",
            "gateway_tls_certificate_env",
            "gateway_tls_key_env",
            "gateway_kubernetes",
        ] {
            assert!(resource.get(field).is_none(), "{field}: {resource}");
        }
    }
    // Sandboxes name their provider registrations by ref.
    let registration =
        provider_scope::address(&resources["openshell_inference"], "inference", "remote");
    assert!(
        sandbox["providers"]
            .as_array()
            .unwrap()
            .contains(&json!(format!("${{{registration}.ref}}"))),
        "{sandbox}"
    );
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
        // The engine's facts and the gateway's prerequisites are separate
        // reads: the facts serve every reader, and the openshell provider
        // judges whether the engine can host its gateway.
        let selected = &document.spec.gateway.as_managed().unwrap().engine;
        let engine = &graph["data"]["host_engine"]["current"];
        assert_eq!(engine["engine"], *selected);
        assert!(engine.get("compute_driver").is_none());
        assert!(engine.get("lifecycle").is_none());
        let prerequisites = &graph["data"]["openshell_gateway_prerequisites"]["current"];
        assert_eq!(prerequisites["engine"], *selected);
        assert_eq!(prerequisites["compute_driver"], "docker");
        assert!(
            prerequisites["lifecycle"]["postcondition"][0]["error_message"]
                .as_str()
                .unwrap()
                .contains("does not meet gateway prerequisites")
        );
        for read in [engine, prerequisites] {
            assert!(
                read.get("depends_on").is_none(),
                "read existing capabilities during plan"
            );
        }
        assert_eq!(
            graph["output"]["discovery"]["value"]["gateway_prerequisites"],
            "${data.openshell_gateway_prerequisites.current.observation_json}"
        );
        let image = &graph["data"]["fabric_harnesses"]["sandbox_0"];
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
        let configuration: serde_json::Value =
            serde_json::from_str(image["config_json"].as_str().unwrap()).unwrap();
        assert_eq!(
            configuration["harness"]["adapter_id"],
            document
                .sandbox_harness(&document.spec.sandboxes[0])
                .unwrap()
                .kind
                .as_str()
        );
        // Fabric v0.5.0 has no per-model API field (#13320); the adapter
        // selects the protocol from the model's provider.
        assert!(configuration["models"]["default"].get("api").is_none());
        assert_eq!(configuration["models"]["default"]["provider"], "openai");
        assert!(graph["output"]["discovery"]["value"].is_object());
    }
}

#[test]
fn arbitrary_fabric_harness_identifier_survives_runtime_compilation() {
    let mut value: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    value["spec"]["sandboxes"][0]["harness"]["kind"] = "org.fixture.custom-adapter".into();
    value["spec"]["sandboxes"][0]["harness"]["settings"] =
        serde_json::json!({"custom_option":"fixture-value"});
    value["spec"]["inferenceProviders"][0]["api"] = "openai-responses".into();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let targets = nemoclaw_sdk::compile::targets(&document, &ownership_generations()).unwrap();
    let sandbox = targets
        .iter()
        .find(|target| target.kind == "sandbox")
        .unwrap();
    assert!(!sandbox.values.contains_key("agent_runtime"));
    let settings: serde_json::Value = nemoclaw_fabric::agent::compose(
        &targets
            .iter()
            .find(|target| target.kind == "agent")
            .unwrap()
            .values,
    )
    .unwrap();
    // Fabric v0.5.0 has no per-model API field (#13320).
    assert!(settings["models"]["default"].get("api").is_none());
    assert_eq!(
        settings["harness"]["settings"]["custom_option"],
        "fixture-value"
    );
    let graph = compile(&document, &ownership_generations(), "0.1.0").unwrap();
    // The sandbox launches what Fabric computed; it holds no agent runtime of its own.
    assert_eq!(
        graph["resource"]["openshell_sandbox"]["assistant"]["launch_json"],
        "${data.fabric_harnesses.sandbox_0.launch_json}"
    );
    assert!(
        graph["resource"]["openshell_sandbox"]["assistant"]
            .get("agent_runtime")
            .is_none()
    );
}

#[test]
fn adding_an_image_keeps_existing_registration_and_separates_executable_scopes() {
    use nemoclaw_sdk::compile::targets;
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
    let before = targets(&document, &generations).unwrap();
    let original = before
        .iter()
        .find(|target| target.kind == "inference")
        .unwrap();
    let mut changed = document.clone();
    let mut second = changed.spec.sandboxes[0].clone();
    second.name = "second".into();
    second.image.ref_ = format!("fixture/other@sha256:{}", "b".repeat(64));
    changed.spec.sandboxes.push(second);
    let after = targets(&changed, &generations).unwrap();
    assert!(after.contains(original));
    assert_eq!(
        after
            .iter()
            .filter(|target| target.kind == "inference")
            .count(),
        2
    );
    assert_eq!(
        changed.selected_inference_providers().unwrap().len(),
        1,
        "authored provider selection is independent of registration count"
    );
    assert_eq!(changed.inference_provider_mut().unwrap().name, "local");
    let graph = compile(&changed, &generations, "0.1.0").unwrap();
    for name in ["assistant", "second"] {
        assert!(
            graph["resource"]["openshell_sandbox"][name]["launch_json"]
                .as_str()
                .unwrap()
                .contains("fabric_harnesses")
        );
    }
    for profile in graph["resource"]["openshell_inference"]
        .as_object()
        .unwrap()
        .values()
    {
        let binaries = profile["binaries"].as_str().unwrap();
        assert!(binaries.starts_with("${jsondecode(data.fabric_harnesses."));
        assert!(binaries.ends_with(".binaries_json)}"));
    }
}
