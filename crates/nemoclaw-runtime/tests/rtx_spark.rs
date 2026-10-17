// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! RTX Spark N1X admission: GPU identity, ARM64 host, and unified-memory capacity.

use nemoclaw_runtime::{
    RuntimeSpec,
    hardware::{Capacity, GIB},
    vllm::{Service, hardware_capacity::serving_memory},
};
use serde_json::{Value, json};

#[test]
fn rtx_spark_serves_on_arm64_using_shared_memory_without_framebuffer_counters() {
    let service = rtx_spark_service();
    let capacity = rtx_spark_capacity("NVIDIA RTX Spark N1X");
    service.check_capacity(&capacity, true, 0, 0).unwrap();
    assert_eq!(serving_memory(&service, &capacity).unwrap(), 128 * GIB);
}

#[test]
fn rtx_spark_accepts_documented_n1x_names_and_rejects_unrecognized_gpu_identities() {
    let service = rtx_spark_service();
    for gpu in [
        "NVIDIA RTX Spark N1X",
        "NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU)",
        "NVIDIA RTX Spark N1X (5120-core Blackwell RTX GPU)",
    ] {
        service
            .check_capacity(&rtx_spark_capacity(gpu), true, 0, 0)
            .unwrap();
    }
    for gpu in [
        "NVIDIA GB10",
        "RTX Spark N1X",
        "NVIDIA RTX Spark N1X2",
        "NVIDIA RTX Spark N1X prototype",
        "NVIDIA RTX Spark N1X (4096-core Blackwell RTX GPU)",
        "NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU) extra",
        "NVIDIA RTX PRO 6000 Blackwell",
    ] {
        assert!(
            service
                .check_capacity(&rtx_spark_capacity(gpu), true, 0, 0)
                .is_err(),
            "{gpu}"
        );
    }
}

#[test]
fn rtx_spark_requires_arm64_compute_12_1_and_a_current_driver() {
    let service = rtx_spark_service();
    for mismatch in ["architecture", "compute", "driver"] {
        let mut capacity = rtx_spark_capacity("NVIDIA RTX Spark N1X");
        match mismatch {
            "architecture" => capacity.architecture = "amd64".into(),
            "compute" => capacity.compute_capability = 120,
            "driver" => capacity.driver_major = 579,
            _ => unreachable!(),
        }
        assert!(
            service.check_capacity(&capacity, true, 0, 0).is_err(),
            "{mismatch}"
        );
    }
}

#[test]
fn rtx_spark_rejects_incompatible_architecture_and_dedicated_memory_declarations() {
    for hardware in [
        json!({"profile": "rtx-spark", "architecture": "amd64"}),
        json!({"profile": "rtx-spark", "minGpuMemoryBytes": 32 * GIB}),
    ] {
        let mut input = rtx_spark_input();
        input["hardware"] = hardware;
        assert!(RuntimeSpec::decode(&input.to_string()).is_err());
    }
    let mut fractional = rtx_spark_input();
    fractional["hardware"]["minGpuMemoryBytes"] = json!(32 * GIB);
    fractional["memory"]["gpuMemoryGiB"] = json!(0);
    fractional["memory"]["kvCacheGiB"] = json!(0);
    fractional["memory"]["gpuMemoryUtilization"] = json!(0.75);
    assert!(RuntimeSpec::decode(&fractional.to_string()).is_err());
}

#[test]
fn rtx_spark_shared_memory_capacity_follows_the_service_budget() {
    let service = rtx_spark_service();
    let mut capacity = rtx_spark_capacity("NVIDIA RTX Spark N1X");
    capacity.total = 116 * GIB;
    capacity.available = 108 * GIB;
    service.check_capacity(&capacity, true, 0, 0).unwrap();
    for mismatch in ["total", "available"] {
        let mut insufficient = capacity.clone();
        match mismatch {
            "total" => insufficient.total -= 1,
            "available" => insufficient.available -= 1,
            _ => unreachable!(),
        }
        assert!(
            service.check_capacity(&insufficient, true, 0, 0).is_err(),
            "{mismatch}"
        );
    }
    capacity.total = 32 * GIB;
    capacity.available = 24 * GIB;
    service
        .hardware
        .as_ref()
        .unwrap()
        .check_compatibility(&capacity)
        .unwrap();
    assert!(service.check_capacity(&capacity, true, 0, 0).is_err());
}

fn rtx_spark_input() -> Value {
    json!({
        "kind": "vllm",
        "hardware": {"profile": "rtx-spark"},
        "model": {"repository": "owner/model", "revision": "a".repeat(40)},
        "serving": {"port": 19103, "contextTokens": 65536, "maxSequences": 1,
            "batchTokens": 1024, "startupTimeoutSeconds": 3600},
        "memory": {"gpuMemoryGiB": 88, "hostReserveGiB": 28, "kvCacheGiB": 8,
            "minAvailableGiB": 8, "minFreeGiB": 3, "freeGateGiB": 12,
            "consecutiveSamples": 5}
    })
}

fn rtx_spark_service() -> Box<Service> {
    let RuntimeSpec::Vllm(service) = RuntimeSpec::decode(&rtx_spark_input().to_string())
        .expect("RTX Spark accepts its ARM64 unified-memory contract")
    else {
        panic!("expected vLLM")
    };
    service
}

fn rtx_spark_capacity(gpu: &str) -> Capacity {
    Capacity {
        architecture: "arm64".into(),
        gpu: gpu.into(),
        driver_major: 580,
        compute_capability: 121,
        total: 128 * GIB,
        available: 120 * GIB,
        disk_free: 500 * GIB,
        ..Default::default()
    }
}
