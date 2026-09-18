// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, Service, ServiceDefinition};

fn service(document: &mut Document) -> &mut Service {
    let ServiceDefinition::Vllm(service) = document.spec.services.get_mut("qwen").unwrap() else {
        panic!("expected vLLM service");
    };
    service
}

#[test]
fn a_different_model_uses_generic_serving_without_recipe_settings() {
    let mut doc = Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let service = service(&mut doc);
    service.recipe = None;
    service.model.repository = "Qwen/Qwen3-0.6B".into();
    service.model.revision = "c1899de289a04d12100db370d81485cdf75e47ca".into();
    service.validate().unwrap();
    let args = service
        .arguments("/data/different-model", 121 << 30)
        .unwrap();
    assert!(
        args.windows(2)
            .any(|p| p == ["--served-model-name", "Qwen/Qwen3-0.6B"])
    );
    for flag in [
        "--mamba-ssm-cache-dtype",
        "--speculative-config",
        "--compilation-config",
    ] {
        assert!(!args.iter().any(|a| a == flag));
    }
    doc.spec.sandboxes[0]
        .agent
        .inference
        .as_mut()
        .unwrap()
        .routes[0]
        .overrides
        .model = "Qwen/Qwen3-0.6B".into();
    doc.validate().unwrap();
}

#[test]
fn model_identity_and_capacity_are_not_a_repository_allowlist() {
    use nemoclaw_sdk::{
        recipes::huggingface as hf,
        snapshot::{File, Manifest},
    };
    let mut doc = Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let service = service(&mut doc);
    service.recipe = None;
    service.model.repository = "some-owner/a-completely-different-model".into();
    service.model.revision = "a".repeat(40);
    service.validate().unwrap();
    let path = hf::directory(service);
    service.model.repository = "another-owner/a-completely-different-model".into();
    assert_ne!(
        hf::directory(service),
        path,
        "repository must be part of storage identity"
    );
    let manifest = Manifest {
        repository: service.model.repository.clone(),
        revision: service.model.revision.clone(),
        files: vec![File {
            name: "model.safetensors".into(),
            size: 1 << 30,
            sha256: "a".repeat(64),
        }],
    };
    hf::validate_manifest(service, &manifest).unwrap();
    let mut wrong = manifest.clone();
    wrong.revision = "b".repeat(40);
    assert!(hf::validate_manifest(service, &wrong).is_err());
    wrong = manifest;
    wrong.files[0].size = 100 << 30;
    assert!(hf::validate_manifest(service, &wrong).is_err());
    service.model.revision = "main".into();
    assert!(service.validate().is_err());
}
