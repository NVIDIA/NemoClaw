// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, compile, runtime_targets},
    config::Document,
};
use serde_json::{Value, json};

fn managed_ollama_service() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("fixtures/config/managed-ollama.yaml")).unwrap();
    let mut unused = value["spec"]["services"]["ollama-server"].clone();
    unused["serving"]["port"] = json!(18999);
    value["spec"]["services"]["unused"] = unused;
    value
}

#[test]
fn declared_services_install_once_and_service_ref_selects_the_inference_connection() {
    let value = managed_ollama_service();
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "ollama_service",
        "managed_gateway",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let runtime = runtime_targets(&document, &generations).unwrap();
    assert!(
        runtime
            .iter()
            .any(|target| target.address == "nemoclaw_ollama_service.ollama-server")
    );
    assert!(
        runtime
            .iter()
            .any(|target| target.address == "nemoclaw_ollama_service.unused")
    );
    let graph = compile(&document, &generations, "0.1.0").unwrap();
    assert_eq!(
        graph["resource"]["nemoclaw_provider_profile"]["inference_local"]["authenticated"],
        "false"
    );
    assert_eq!(
        document.inference_endpoint().unwrap(),
        "http://172.20.0.1:18888/v1"
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
    provider["service"] = inline;
    assert!(Document::parse(legacy.to_string().as_bytes()).is_err());
}

#[test]
fn removed_ollama_backends_cannot_resolve_saved_resource_rows() {
    let connections = nemoclaw_sdk::docker::Connections::default();
    let registry = nemoclaw_sdk::services::BackendRegistry::new(&connections);
    for kind in ["ollama", "ollama_storage", "ollama_model"] {
        assert!(!nemoclaw_sdk::services::installers::ollama::ProxyBackend::supports(kind));
        assert!(
            registry
                .resolve(kind, &Default::default())
                .unwrap()
                .is_none()
        );
    }
}
