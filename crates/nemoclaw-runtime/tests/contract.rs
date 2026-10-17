// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::RuntimeSpec;
use serde_json::json;

#[test]
fn runtime_accepts_serving_contract_without_deployment_configuration() {
    let mut input = json!({
        "kind": "vllm",
        "hardware": {"profile": "a100", "architecture": "amd64"},
        "model": {"repository": "owner/model", "revision": "a".repeat(40)},
        "serving": {"port": 18888, "contextTokens": 32768, "maxSequences": 1,
            "batchTokens": 1024, "startupTimeoutSeconds": 1800},
        "memory": {"hostReserveGiB": 32, "kvCacheGiB": 8, "minAvailableGiB": 8,
            "minFreeGiB": 3, "freeGateGiB": 12, "consecutiveSamples": 5}
    });
    RuntimeSpec::decode(&input.to_string()).unwrap();
    for field in [
        "image",
        "imagePullPolicy",
        "placement",
        "publication",
        "container",
    ] {
        input[field] = json!({});
        assert!(RuntimeSpec::decode(&input.to_string()).is_err(), "{field}");
        input.as_object_mut().unwrap().remove(field);
    }
    input["serving"]["port"] = 0.into();
    assert!(RuntimeSpec::decode(&input.to_string()).is_err());
}

#[test]
fn rtx_spark_serves_on_arm64_using_shared_memory_without_framebuffer_counters() {
    use nemoclaw_runtime::hardware::GIB;

    let service = rtx_spark_service();
    let capacity = rtx_spark_capacity("NVIDIA RTX Spark N1X");
    service.check_capacity(&capacity, true, 0, 0).unwrap();
    assert_eq!(
        nemoclaw_runtime::vllm::hardware_capacity::serving_memory(&service, &capacity).unwrap(),
        128 * GIB
    );
}

fn rtx_spark_input() -> serde_json::Value {
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

fn rtx_spark_service() -> Box<nemoclaw_runtime::vllm::Service> {
    let RuntimeSpec::Vllm(service) = RuntimeSpec::decode(&rtx_spark_input().to_string())
        .expect("RTX Spark accepts its ARM64 unified-memory contract")
    else {
        panic!("expected vLLM")
    };
    service
}

fn rtx_spark_capacity(gpu: &str) -> nemoclaw_runtime::hardware::Capacity {
    use nemoclaw_runtime::hardware::{Capacity, GIB};

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
    use nemoclaw_runtime::hardware::GIB;

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
    use nemoclaw_runtime::hardware::GIB;

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

#[test]
fn runtime_rejects_unsafe_recipe_paths_and_protected_environment_before_work() {
    let original: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    RuntimeSpec::decode(&original.to_string()).unwrap();
    for (pointer, value) in [
        ("/recipe/preparation/executable", json!("/opt/../bin/sh")),
        ("/recipe/verification/sha256", json!("not-a-digest")),
        ("/recipe/apiVersion", json!("unsupported")),
        ("/recipe/resources/preparedBytes", json!(0)),
        ("/memory/consecutiveSamples", json!(0)),
    ] {
        let mut input = original.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(
            RuntimeSpec::decode(&input.to_string()).is_err(),
            "{pointer}"
        );
    }
    let mut input = original;
    input["recipe"]["serving"]["environment"] = json!({"VLLM_API_KEY":"must-not-be-exposed"});
    let error = RuntimeSpec::decode(&input.to_string())
        .unwrap_err()
        .to_string();
    assert!(!error.contains("must-not-be-exposed"));
}

#[test]
fn direct_recipe_validation_rejects_structurally_invalid_preparation_limits() {
    let input: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    let RuntimeSpec::Vllm(mut service) = RuntimeSpec::decode(&input.to_string()).unwrap() else {
        panic!("vLLM fixture")
    };
    service.recipe.as_mut().unwrap().resources.prepared_bytes = 0;
    assert!(service.recipe.as_ref().unwrap().validate(&service).is_err());
}

#[test]
fn runtime_errors_identify_declared_fields_without_echoing_values_or_map_keys() {
    let original: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/vllm.yaml")).unwrap();
    for (pointer, value, field) in [
        ("/serving/port", json!("PRIVATE_SENTINEL"), "port"),
        ("/serving/port", json!(0), "port"),
        (
            "/recipe/apiVersion",
            json!("PRIVATE_SENTINEL"),
            "apiVersion",
        ),
        ("/memory/consecutiveSamples", json!(0), "consecutiveSamples"),
    ] {
        let mut input = original.clone();
        *input.pointer_mut(pointer).unwrap() = value;
        let error = RuntimeSpec::decode(&input.to_string())
            .unwrap_err()
            .to_string();
        assert!(error.contains(field), "{error}");
        assert!(error.contains("v1"), "{error}");
        assert!(!error.contains("PRIVATE_SENTINEL"), "{error}");
    }
    for pointer in ["", "/serving", "/recipe/serving/environment"] {
        let mut input = original.clone();
        if pointer.ends_with("/environment") {
            input["recipe"]["serving"]["environment"] = json!({});
        }
        input.pointer_mut(pointer).unwrap()["PRIVATE_SENTINEL"] = json!("PRIVATE_SENTINEL");
        let error = RuntimeSpec::decode(&input.to_string())
            .unwrap_err()
            .to_string();
        assert!(error.contains("runtime specification"), "{error}");
        assert!(!error.contains("PRIVATE_SENTINEL"), "{error}");
    }
}
