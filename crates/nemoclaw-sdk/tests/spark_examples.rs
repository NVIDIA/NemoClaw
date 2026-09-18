// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, runtime_targets, targets},
    config::Document,
};

#[test]
fn spark_scenarios_compile_their_shared_and_independent_resources() {
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    for (name, services, sandboxes, agents) in [
        ("pi-small.yaml", 1, 1, 1),
        ("deepagents-team.yaml", 1, 2, 2),
        ("shared-model.yaml", 1, 3, 3),
        ("two-models.yaml", 2, 1, 1),
        ("local-and-hosted.yaml", 1, 1, 1),
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/spark")
            .join(name);
        let doc = Document::parse(std::fs::File::open(path).unwrap())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let runtime = runtime_targets(&doc, &generations).unwrap();
        assert_eq!(
            runtime
                .iter()
                .filter(|r| r.kind == "inference_service")
                .count(),
            services,
            "{name}"
        );
        assert_eq!(
            targets(&doc, &generations)
                .unwrap()
                .iter()
                .filter(|r| r.kind == "sandbox")
                .count(),
            sandboxes,
            "{name}"
        );
        assert_eq!(
            doc.spec.sandboxes.iter().map(|_| 1_usize).sum::<usize>(),
            agents,
            "{name}"
        );
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );
        for provider in &doc.spec.inference_providers {
            if let Some(service) = &provider.service {
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
    }
}
