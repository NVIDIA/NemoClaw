// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, runtime_targets, targets},
    config::{Document, ServiceDefinition},
    services::installers::vllm::{HardwareProfile, ServiceHardware},
};

#[test]
fn arm64_hardware_scenarios_compile_their_declared_resources() {
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    for (directory, name) in [
        ("spark", "pi-small.yaml"),
        ("spark", "deepagents-team.yaml"),
        ("spark", "shared-model.yaml"),
        ("spark", "two-models.yaml"),
        ("spark", "local-and-hosted.yaml"),
        ("station", "vllm.yaml"),
        ("station", "shared-model.yaml"),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples")
            .join(directory)
            .join(name);
        let doc = Document::parse(std::fs::File::open(path).unwrap())
            .unwrap_or_else(|error| panic!("{directory}/{name}: {error}"));
        let runtime = runtime_targets(&doc, &generations).unwrap();
        assert_eq!(
            runtime
                .iter()
                .filter(|r| r.kind == "inference_service")
                .count(),
            doc.spec
                .services
                .values()
                .filter(|service| matches!(service, ServiceDefinition::Vllm(_)))
                .count(),
            "{directory}/{name}"
        );
        assert_eq!(
            targets(&doc, &generations)
                .unwrap()
                .iter()
                .filter(|r| r.kind == "sandbox")
                .count(),
            doc.spec.sandboxes.len(),
            "{directory}/{name}"
        );
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );
        for provider in &doc.spec.inference_providers {
            if let Some(name) = &provider.service_ref {
                let ServiceDefinition::Vllm(service) = &doc.spec.services[name] else {
                    panic!("{name}: expected vLLM service");
                };
                assert!(
                    service.authentication.is_some(),
                    "{name}: managed inference requires bearer auth"
                );
                let args = service
                    .arguments("/data/model", 121 * nemoclaw_sdk::hardware::GIB)
                    .unwrap();
                assert!(!args.iter().any(|arg| arg == "--trust-remote-code"));
            }
        }
        if directory == "station" {
            assert_eq!(doc.spec.services.len(), 1, "station/{name}");
            let ServiceDefinition::Vllm(service) = doc.spec.services.values().next().unwrap()
            else {
                panic!("station/{name}: expected vLLM service");
            };
            assert_eq!(
                service.hardware,
                Some(ServiceHardware::Profile {
                    profile: HardwareProfile::DgxStation,
                    architecture: None,
                    min_gpu_memory_bytes: None,
                })
            );
            assert!(service.image.starts_with("nc-prototype-vllm@sha256:"));
            for sandbox in &doc.spec.sandboxes {
                assert!(sandbox.image.ref_.starts_with("nc-fabric@sha256:"));
            }
            if name == "shared-model.yaml" {
                assert_eq!(doc.spec.inference_providers.len(), 1);
                assert_eq!(doc.spec.sandboxes.len(), 2);
                assert_eq!(service.serving.max_sequences, 2);
            }
        }
    }
}
