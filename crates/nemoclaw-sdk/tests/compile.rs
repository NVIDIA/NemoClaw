// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{compile::compile, config::Document};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::Path};

#[test]
fn image_pull_policy_reaches_the_engine_without_changing_runtime_identity() {
    use nemoclaw_sdk::{compile::compile_runtime, config::ImagePullPolicy};
    let generations = [
        ("workspace", "workspace-generation"),
        ("provider", "provider-generation"),
        ("sandbox", "sandbox-generation"),
        ("ollama", "ollama-generation"),
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
    service.runtime.image_pull_policy = Some(ImagePullPolicy::IfNotPresent);
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
    let before = compile(&document, &generations, "0.1.0").unwrap();
    let nemoclaw_sdk::services::ServiceDefinition::Ollama(service) =
        document.spec.services.values_mut().next().unwrap()
    else {
        panic!("expected ollama")
    };
    service.runtime.image_pull_policy = Some(ImagePullPolicy::Never);
    let mut after = compile(&document, &generations, "0.1.0").unwrap();
    for (kind, name) in [
        ("nemoclaw_ollama", "ollama-server"),
        ("nemoclaw_ollama_storage", "ollama-server"),
    ] {
        assert_eq!(
            after["resource"][kind][name]
                .as_object_mut()
                .unwrap()
                .remove("image_pull_policy")
                .unwrap(),
            "Never"
        );
    }
    assert_eq!(after, before);
}

#[test]
fn reference_graphs_preserve_addresses_dependencies_and_provider_configuration() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let generations: BTreeMap<String, String> = [
        ("workspace", "workspace-generation"),
        ("provider", "provider-generation"),
        ("sandbox", "sandbox-generation"),
        ("ollama", "ollama-generation"),
        ("managed_gateway", "gateway-generation"),
        ("inference_service", "inference-generation"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    for entry in fs::read_dir(root.join("compile")).unwrap() {
        let path = entry.unwrap().path();
        let input = fs::read(root.join("config").join(path.file_stem().unwrap())).unwrap();
        let document = Document::parse(input.as_slice()).unwrap();
        let expected: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let actual = compile(&document, &generations, "0.1.0")
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        assert_eq!(actual, expected, "{}", path.display());
    }
    let document = Document::parse(include_str!("fixtures/config/local.yaml").as_bytes()).unwrap();
    assert!(compile(&document, &BTreeMap::new(), "0.1.0").is_err());
}
