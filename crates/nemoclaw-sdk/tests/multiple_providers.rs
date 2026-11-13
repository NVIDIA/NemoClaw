// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::provider_scope;
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
        "ollama_service",
        "managed_gateway",
        "inference_service",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into()
}
fn hosted(mut value: Value) -> Value {
    value["spec"]["inferenceProviders"]["hosted"] = json!({"provider":"anthropic","api":"anthropic-messages","endpoint":"https://hosted.example/v1","credential":{"env":"HOSTED_KEY"}});
    let inference = &mut value["spec"]["sandboxes"]["assistant"]["agent"]["inference"];
    inference["default"] = json!("smart");
    inference["routes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"smart","providerRef":"hosted","overrides":{"model":"smart-model"}}));
    value
}
#[test]
fn a_sandbox_attaches_the_union_of_selected_providers_with_bound_credentials() {
    let input: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    let mut value = hosted(input);
    let mut other = value["spec"]["sandboxes"]["assistant"].clone();
    other["agent"]["inference"]["routes"]
        .as_array_mut()
        .unwrap()
        .pop();
    other["agent"]["inference"]
        .as_object_mut()
        .unwrap()
        .remove("default");
    value["spec"]["sandboxes"]["other"] = other;
    let doc = Document::parse(value.to_string().as_bytes()).expect("local and hosted providers");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert_eq!(doc.credential_names(), vec!["HOSTED_KEY"]);
    let rows = targets(&doc, &generations()).unwrap();
    assert_eq!(rows.iter().filter(|row| row.kind == "inference").count(), 2);
    let sandbox = rows.iter().find(|row| row.kind == "sandbox").unwrap();
    let settings: Value = nemoclaw_fabric::agent::compose(
        &rows
            .iter()
            .find(|row| row.kind == "agent" && row.values["sandbox"] == sandbox.values["name"])
            .unwrap()
            .values,
    )
    .unwrap();
    assert!(sandbox.values["provider_names_json"].contains("hosted"));
    assert_eq!(
        settings["models"]["smart"]["api_key_env"],
        format!(
            "NEMOCLAW_INFERENCE_{}_KEY",
            rows.iter()
                .find(|row| row.kind == "inference" && row.values["name"].starts_with("hosted-"))
                .unwrap()
                .values["name"]
                .replace('-', "_")
                .to_ascii_uppercase()
        )
    );
    let other = rows
        .iter()
        .find(|row| row.kind == "sandbox" && row.values["name"] == "other")
        .unwrap();
    let other_settings: Value = nemoclaw_fabric::agent::compose(
        &rows
            .iter()
            .find(|row| row.kind == "agent" && row.values["sandbox"] == "other")
            .unwrap()
            .values,
    )
    .unwrap();
    assert_eq!(
        other_settings["models"]["primary"]["api_key_env"],
        "NEMOCLAW_ANONYMOUS_API_KEY"
    );
    assert!(other_settings["models"]["smart"].is_null());
    let other_policy: Value = serde_json::from_str(&other.values["policy_json"]).unwrap();
    assert_eq!(other_policy["managed"].as_array().unwrap().len(), 1);
    let policy: Value = serde_json::from_str(&sandbox.values["policy_json"]).unwrap();
    assert_eq!(policy["managed"].as_array().unwrap().len(), 2);
    let graph = compile(&doc, &generations(), "0.1.0").unwrap();
    let mut dependencies: Vec<_> = rows
        .iter()
        .filter(|row| row.kind == "inference")
        .map(|row| json!(row.address))
        .collect();
    dependencies.push(json!("data.openshell_gateway.apply"));
    assert_eq!(
        graph["resource"]["openshell_sandbox"]["assistant"]["depends_on"],
        json!(dependencies)
    );
    assert_eq!(
        graph["resource"]["openshell_sandbox"]["other"]["depends_on"],
        json!([
            provider_scope::address(
                &graph["resource"]["openshell_inference"],
                "inference",
                "local"
            ),
            "data.openshell_gateway.apply"
        ])
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
}
/// OpenShell attaches at most 32 providers to one sandbox; a deployment has no
/// such limit, so sandboxes with their own credentials scale with the fleet.
#[test]
fn a_kubernetes_deployment_selects_a_provider_for_each_of_256_sandboxes() {
    let mut value: Value = serde_saphyr::from_str(include_str!(
        "../../../examples/kubernetes/managed-development.yaml"
    ))
    .unwrap();
    let mut sandbox = value["spec"]["sandboxes"]["assistant"].clone();
    sandbox["inferenceProviders"] =
        json!({"own": value["spec"]["inferenceProviders"]["hosted-nvidia"]});
    sandbox["agent"] = json!({"name": "primary", "inference": {"routes": [
        {"name": "primary", "providerRef": "own", "overrides": {"model": "nvidia/nemotron-3-ultra-550b-a55b"}}
    ]}});
    value["spec"]["sandboxes"] = Value::Object(
        (0..256)
            .map(|index| (format!("agent-{index}"), sandbox.clone()))
            .collect(),
    );
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert_eq!(document.selected_inference_providers().unwrap().len(), 256);
}

/// Inference providers, web search, and `api` integrations each attach one
/// provider to the sandbox, and OpenShell refuses a sandbox with more than 32.
#[test]
fn a_sandbox_with_more_than_32_attached_providers_is_rejected_by_name() {
    let input: Value =
        serde_saphyr::from_str(include_str!("../../../examples/web-search.yaml")).unwrap();
    // The researcher attaches web search beside its inference providers,
    // and with `api`, an api integration.
    let attach = |providers: usize, api: bool| {
        let mut value = input.clone();
        if api {
            value["spec"]["integrations"]["bookings"] = json!({
                "kind": "api", "endpoint": "https://bookings.example.com/mcp",
                "credential": {"env": "BOOKINGS_API_KEY"}
            });
            value["spec"]["sandboxes"]["researcher"]["agent"]["integrationRefs"] =
                json!(["search", "bookings"]);
        }
        let researcher = &mut value["spec"]["sandboxes"]["researcher"];
        researcher["inferenceProviders"] = Value::Object(
            (0..providers)
                .map(|index| {
                    (
                        format!("p{index}"),
                        json!({"provider": "openai", "endpoint": "http://172.20.0.1:11446/v1"}),
                    )
                })
                .collect(),
        );
        researcher["agent"]["inference"] = json!({
            "default": "r0",
            "routes": (0..providers)
                .map(|index| json!({"name": format!("r{index}"), "providerRef": format!("p{index}"), "overrides": {"model": "qwen3:4b"}}))
                .collect::<Vec<_>>()
        });
        value
    };
    for (providers, api) in [(31, false), (30, true)] {
        Document::parse(attach(providers, api).to_string().as_bytes())
            .unwrap_or_else(|error| panic!("{providers} providers, api {api}: {error}"));
    }
    for (providers, api) in [(32, false), (31, true)] {
        let error = Document::parse(attach(providers, api).to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("spec.sandboxes[researcher]")
                && error.contains("attaches 33")
                && error.contains("at most 32"),
            "{providers} providers, api {api}: {error}"
        );
    }
}

#[test]
fn managed_inference_remains_owned_when_the_default_uses_a_hosted_provider() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    let local_name = value["spec"]["inferenceProviders"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .to_owned();
    value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    let doc = Document::parse(hosted(value).to_string().as_bytes())
        .expect("managed local model plus external default");
    let runtime = runtime_targets(&doc, &generations()).unwrap();
    assert!(runtime.iter().any(|row| row.kind == "inference_service"));
    let rows = targets(&doc, &generations()).unwrap();
    assert_eq!(rows.iter().filter(|row| row.kind == "inference").count(), 2);
    assert!(
        rows.iter()
            .find(|row| row.kind == "inference"
                && row.values["name"].starts_with(&format!("{local_name}-")))
            .unwrap()
            .values
            .contains_key("credential_source")
    );
    assert!(
        !rows
            .iter()
            .find(|row| row.kind == "inference" && row.values["name"].starts_with("hosted-"))
            .unwrap()
            .values
            .contains_key("credential_source")
    );
}

#[test]
fn managed_ollama_installs_while_an_external_provider_is_the_default() {
    let value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/managed-ollama.yaml")).unwrap();
    let local_name = value["spec"]["inferenceProviders"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .to_owned();
    let doc = Document::parse(hosted(value).to_string().as_bytes()).unwrap();
    let runtime = runtime_targets(&doc, &generations()).unwrap();
    assert!(
        runtime
            .iter()
            .any(|target| target.address == "docker_container.ollama_service_ollama-server")
    );
    let graph = compile(&doc, &generations(), "0.1.0").unwrap();
    let dependencies = provider_scope::resource(
        &graph["resource"]["openshell_inference"],
        &local_name,
    )["depends_on"]
        .as_array()
        .unwrap();
    assert_eq!(dependencies, &[json!("data.openshell_gateway.apply")]);
}

#[test]
fn multiple_selected_ollama_installers_have_independent_resources_and_dependencies() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/managed-ollama.yaml")).unwrap();
    let mut other = value["spec"]["inferenceProviders"]["local"].clone();
    other["serviceRef"] = json!("other");
    let mut other_service = value["spec"]["services"]["ollama-server"].clone();
    other_service["serving"]["port"] = json!(18999);
    value["spec"]["services"]["other"] = other_service;
    value["spec"]["inferenceProviders"]["other"] = other;
    let inference = &mut value["spec"]["sandboxes"]["assistant"]["agent"]["inference"];
    inference["default"] = json!("primary");
    let mut route = inference["routes"][0].clone();
    route["name"] = json!("other");
    route["providerRef"] = json!("other");
    inference["routes"].as_array_mut().unwrap().push(route);
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let runtime = runtime_targets(&document, &generations()).unwrap();
    let graph = nemoclaw_sdk::compile::compile_runtime(&document, &generations(), "0.1.0").unwrap();
    for service in ["ollama-server", "other"] {
        assert!(
            runtime.iter().any(
                |target| target.address == format!("docker_container.ollama_service_{service}")
            )
        );
        assert!(
            graph["resource"]["docker_container"][format!("ollama_service_{service}")]["depends_on"]
                .as_array()
                .unwrap()
                .contains(&json!(format!("docker_volume.ollama_service_storage_{service}")))
        );
    }
}

#[test]
fn managed_services_have_independent_storage_credentials_and_dependencies() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    let first = "qwen";
    value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
    let mut other = value["spec"]["inferenceProviders"][first].clone();
    other["serviceRef"] = json!("other");
    let mut other_service = value["spec"]["services"]["qwen"].clone();
    other_service["serving"]["port"] = json!(18999);
    value["spec"]["services"]["other"] = other_service;
    value["spec"]["inferenceProviders"]["other"] = other;
    let inference = &mut value["spec"]["sandboxes"]["assistant"]["agent"]["inference"];
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
    for name in [first, "other"] {
        let address = format!("docker_container.inference_service_inference_{name}");
        let service = runtime.iter().find(|t| t.address == address).unwrap();
        let spec: Value = serde_json::from_str(&service.values["spec"]).unwrap();
        let credentials: Value = serde_json::from_str(
            &rows
                .iter()
                .find(|t| {
                    t.kind == "inference" && t.values["name"].starts_with(&format!("{name}-"))
                })
                .unwrap()
                .values["credential_source"],
        )
        .unwrap();
        assert_eq!(credentials["container"], spec["name"]);
        assert_eq!(credentials["storage"]["Owner"], spec["owner"]);
        assert_eq!(credentials["storage"]["Generation"], spec["generation"]);
        assert_eq!(
            credentials["storage"]["Name"],
            format!("{}-auth", spec["name"].as_str().unwrap())
        );
        assert!(credentials.get("spec").is_none());
        let dependencies = graph["resource"]["docker_container"]
            [format!("inference_service_inference_{name}")]["depends_on"]
            .as_array()
            .unwrap();
        assert!(dependencies.contains(&json!(format!(
            "vllm_credential_storage.inference_{name}_auth"
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
