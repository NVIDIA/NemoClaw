// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::{Document, schema::input_schema},
    hardware::{Capacity, GIB, GpuMemory, check_capacity, serving_memory},
};
use serde_json::{Value, json};

fn input(hardware: Value) -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    value["spec"]["inferenceProviders"][0]["service"]["hardware"] = hardware;
    value
}

#[test]
fn profiles_validate_gpu_identity_and_keep_hbm_separate_from_host_ram() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for (profile, gpu, cc, fixed_architecture) in [
        ("dgx-station", "NVIDIA GB300", 103, true),
        ("gb200", "NVIDIA GB200", 100, true),
        ("gb300", "NVIDIA GB300", 103, true),
        ("gh200", "NVIDIA GH200 480GB", 90, true),
        ("h100", "NVIDIA H100 80GB HBM3", 90, false),
        ("h200", "NVIDIA H200", 90, false),
        ("a100", "NVIDIA A100-SXM4-80GB", 80, false),
        ("a10", "NVIDIA A10", 86, false),
        ("a10g", "NVIDIA A10G", 86, false),
        ("a40", "NVIDIA A40", 86, false),
        ("l4", "NVIDIA L4", 89, false),
        ("l40", "NVIDIA L40", 89, false),
        ("l40s", "NVIDIA L40S", 89, false),
        ("t4", "Tesla T4", 75, false),
        ("rtx-6000-ada", "NVIDIA RTX 6000 Ada Generation", 89, false),
        (
            "rtx-pro-6000-blackwell",
            "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            120,
            false,
        ),
        ("rtx-3090", "NVIDIA GeForce RTX 3090", 86, false),
        ("rtx-4090", "NVIDIA GeForce RTX 4090", 89, false),
        ("rtx-5090", "NVIDIA GeForce RTX 5090", 120, false),
    ] {
        for architecture in if fixed_architecture {
            &["arm64"][..]
        } else {
            &["amd64", "arm64"][..]
        } {
            let mut hardware = json!({"profile": profile});
            if !fixed_architecture {
                hardware["architecture"] = json!(architecture);
            }
            let value = input(hardware);
            assert!(schema.is_valid(&value), "{profile}");
            let doc = Document::parse(value.to_string().as_bytes()).unwrap();
            assert_eq!(
                Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
                doc
            );
            let service = doc.spec.inference_providers[0].service.as_ref().unwrap();
            // Fixture capacity, not a datasheet assertion about this GPU model.
            let capacity = Capacity {
                architecture: (*architecture).into(),
                gpu: gpu.into(),
                driver_major: 610,
                total: 512 * GIB,
                available: 400 * GIB,
                free: 300 * GIB,
                disk_free: 500 * GIB,
                compute_capability: cc,
                gpu_memory: Some(GpuMemory {
                    total: 80 * GIB,
                    free: 70 * GIB,
                }),
                ..Default::default()
            };
            check_capacity(service, &capacity, true, 0, 0).unwrap();
            assert_eq!(serving_memory(service, &capacity).unwrap(), 80 * GIB);
            for mismatch in [
                "name",
                "architecture",
                "compute",
                "memory",
                "free",
                "driver",
                "host",
            ] {
                let mut bad = capacity.clone();
                match mismatch {
                    "name" => bad.gpu = "NVIDIA unrelated GPU".into(),
                    "architecture" => {
                        bad.architecture = if *architecture == "arm64" {
                            "amd64"
                        } else {
                            "arm64"
                        }
                        .into()
                    }
                    "compute" => bad.compute_capability = cc - 1,
                    "memory" => bad.gpu_memory = None,
                    "free" => bad.gpu_memory.as_mut().unwrap().free = GIB,
                    "driver" => bad.driver_major = 579,
                    "host" => bad.available = GIB,
                    _ => unreachable!(),
                }
                assert!(
                    check_capacity(service, &bad, true, 0, 0).is_err(),
                    "{profile}: {mismatch}"
                );
            }
        }
    }
}

#[test]
fn profile_schema_requires_gpu_host_architecture_and_rejects_ambiguous_names() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for hardware in [
        json!({"profile":"spark"}),
        json!({"profile":"gb100"}),
        json!({"profile":"b200"}),
        json!({"profile":"h100"}),
        json!({"profile":"l4", "architecture":"riscv64"}),
        json!({"profile":"dgx-station", "architecture":"amd64"}),
        json!({"profile":"dgx-spark", "minGpuMemoryBytes": 16 * GIB}),
        json!({"profile":"h100", "architecture":"amd64", "minComputeCapability":90}),
        json!({"profile":"h100", "architecture":"amd64", "minGpuMemoryBytes": null}),
        json!({"profile":"h100", "architecture":"amd64", "minGpuMemoryBytes": 0}),
        json!({"profile":"h100", "architecture":"amd64", "minGpuMemoryBytes": 5_u64 * (1 << 40)}),
        json!({"profile":"dgx-spark", "architecture": null}),
    ] {
        let value = input(hardware);
        assert!(
            Document::parse(value.to_string().as_bytes()).is_err(),
            "{value}"
        );
        assert!(!schema.is_valid(&value));
    }
    let value = input(json!({"profile":"dgx-spark"}));
    assert!(Document::parse(value.to_string().as_bytes()).is_ok());
    assert!(schema.is_valid(&value));
}

#[test]
fn fractional_profile_budgets_require_an_explicit_minimum_memory() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input(json!({"profile":"h100", "architecture":"amd64"}));
    value["spec"]["inferenceProviders"][0]["service"]["memory"] =
        json!({"gpuMemoryUtilization": 0.75});
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    assert!(!schema.is_valid(&value));
    value["spec"]["inferenceProviders"][0]["service"]["hardware"]["minGpuMemoryBytes"] =
        json!(64 * GIB);
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(schema.is_valid(&value));
    let service = doc.spec.inference_providers[0].service.as_ref().unwrap();
    assert_eq!(service.gpu_bytes().unwrap(), 48 * GIB);
    let args = service.arguments("/data/model", 80 * GIB).unwrap();
    assert!(
        args.windows(2)
            .any(|p| p == ["--gpu-memory-utilization", "0.75"])
    );
    assert!(service.arguments("/data/model", 60 * GIB).is_err());
}

#[test]
fn similar_gpu_names_cannot_satisfy_a_different_profile() {
    for (profile, other) in [
        ("l4", "L40"),
        ("l40", "L40S"),
        ("a10", "A10G"),
        ("h100", "H1000"),
    ] {
        let value = input(json!({"profile":profile,"architecture":"amd64"}));
        let doc = Document::parse(value.to_string().as_bytes()).unwrap();
        let service = doc.spec.inference_providers[0].service.as_ref().unwrap();
        let capacity = Capacity {
            architecture: "amd64".into(),
            gpu: format!("NVIDIA {other}"),
            driver_major: 610,
            total: 128 * GIB,
            available: 100 * GIB,
            disk_free: 500 * GIB,
            compute_capability: 120,
            gpu_memory: Some(GpuMemory {
                total: 80 * GIB,
                free: 70 * GIB,
            }),
            ..Default::default()
        };
        assert!(
            check_capacity(service, &capacity, true, 0, 0).is_err(),
            "{profile}: {other}"
        );
    }
}
