// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::{
    hardware::Capacity, hardware::GIB, hardware::GpuMemory, vllm::hardware_capacity,
};
use nemoclaw_sdk::{
    config::Document, config::ServiceDefinition, services::installers::vllm::Service,
};
fn service() -> Service {
    let mut document =
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap();
    let ServiceDefinition::Vllm(service) = document.spec.services.remove("qwen").unwrap() else {
        panic!("expected vLLM service");
    };
    *service
}
#[test]
fn recipe_selection_preserves_artifacts_and_rejects_unqualified_combinations() {
    let mut service = service();
    let recipe = service.recipe.as_ref().unwrap();
    let capacity = Capacity {
        architecture: "arm64".into(),
        gpu: "NVIDIA GB10".into(),
        driver_major: 580,
        compute_capability: 121,
        total: 121 * GIB,
        available: 116 * GIB,
        disk_free: 200 * GIB,
        ..Default::default()
    };
    hardware_capacity::check_capacity(
        &service,
        &capacity,
        true,
        recipe.snapshot.as_ref().unwrap().bytes().unwrap(),
        recipe.resources.prepared_bytes,
    )
    .unwrap();
    let args = service.arguments("/data/model", capacity.total).unwrap();
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--gpu-memory-utilization", "0.706"])
    );
    assert!(
        args.windows(2)
            .any(|p| p == ["--served-model-name", "fixture-model"])
    );
    let mut wrong_hardware = capacity;
    wrong_hardware.gpu = "other GPU".into();
    assert!(hardware_capacity::check_capacity(&service, &wrong_hardware, true, 0, 0).is_err());
    service.model.revision = "0".repeat(40);
    assert!(service.validate().is_err());
    let mut document = serde_json::to_value(
        Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes()).unwrap(),
    )
    .unwrap();
    document["spec"]["services"]["qwen"]["kind"] = "llamaCpp".into();
    assert!(Document::parse(serde_json::to_vec(&document).unwrap().as_slice()).is_err());
}

#[test]
fn a_recipe_for_a_dedicated_memory_gpu_is_budgeted_against_gpu_memory() {
    let mut service = service();
    let recipe = service.recipe.as_mut().unwrap();
    recipe.compatibility.architecture = "amd64".into();
    recipe.compatibility.gpu = "NVIDIA H100 80GB HBM3".into();
    recipe.compatibility.min_host_memory_gi_b = 48;
    recipe.resources.gpu_memory_bytes = 60 * GIB;
    recipe.resources.preparation_memory_gi_b = 8;
    recipe.resources.startup_headroom_gi_b = 10;
    // Host total and available memory are below the 60 GiB budget but cover the 32 GiB reserve
    // and 10 GiB headroom.
    let capacity = Capacity {
        architecture: "amd64".into(),
        gpu: "NVIDIA H100 80GB HBM3".into(),
        driver_major: 580,
        compute_capability: 90,
        total: 48 * GIB,
        available: 45 * GIB,
        disk_free: 200 * GIB,
        gpu_memory: Some(GpuMemory {
            total: 80 * GIB,
            free: 79 * GIB,
        }),
        ..Default::default()
    };
    hardware_capacity::check_capacity(&service, &capacity, true, 0, 0).unwrap();
    let total = hardware_capacity::serving_memory(&service, &capacity).unwrap();
    assert_eq!(total, 80 * GIB);
    let args = service.arguments("/data/model", total).unwrap();
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--gpu-memory-utilization", "0.750"]),
        "{args:?}"
    );

    let gpu = |total, free| {
        let mut capacity = capacity.clone();
        capacity.gpu_memory = Some(GpuMemory { total, free });
        capacity
    };
    for (observed, starting) in [
        (gpu(59 * GIB, 59 * GIB), false),
        (gpu(80 * GIB, 59 * GIB), true),
    ] {
        let error = hardware_capacity::check_memory(&service, &observed, starting).unwrap_err();
        assert!(error.to_string().contains("GPU"), "{error}");
    }
    hardware_capacity::check_memory(&service, &gpu(80 * GIB, 59 * GIB), false).unwrap();
    let mut no_gpu_counters = capacity.clone();
    no_gpu_counters.gpu_memory = None;
    assert!(hardware_capacity::check_memory(&service, &no_gpu_counters, false).is_err());
    let mut short_headroom = capacity;
    short_headroom.available = 41 * GIB;
    let error = hardware_capacity::check_memory(&service, &short_headroom, true).unwrap_err();
    assert!(
        error.to_string().contains("host available memory"),
        "{error}"
    );
}

#[test]
fn a_recipe_gpu_outside_the_hardware_profiles_is_rejected() {
    let mut service = service();
    let recipe = service.recipe.as_mut().unwrap();
    recipe.compatibility.architecture = "amd64".into();
    recipe.compatibility.gpu = "NVIDIA fixture GPU".into();
    let error = service.validate().unwrap_err();
    assert!(error.to_string().contains("compatibility.gpu"), "{error}");
}

#[test]
fn declared_compatibility_does_not_bypass_capacity_or_memory_policy() {
    let mut service = service();
    let recipe = service.recipe.as_mut().unwrap();
    recipe.compatibility.architecture = "amd64".into();
    recipe.compatibility.gpu = "NVIDIA H200".into();
    let mut capacity = Capacity {
        architecture: "amd64".into(),
        gpu: "NVIDIA H200".into(),
        driver_major: 580,
        compute_capability: 90,
        total: 121 * GIB,
        available: 116 * GIB,
        disk_free: 200 * GIB,
        gpu_memory: Some(GpuMemory {
            total: 141 * GIB,
            free: 140 * GIB,
        }),
        ..Default::default()
    };
    hardware_capacity::check_capacity(&service, &capacity, true, 0, 0).unwrap();
    capacity.available = 0;
    assert!(hardware_capacity::check_capacity(&service, &capacity, true, 0, 0).is_err());
    capacity.available = 116 * GIB;
    capacity.disk_free = 0;
    assert!(hardware_capacity::check_capacity(&service, &capacity, true, 0, 0).is_err());
    service.memory.host_reserve_gib = 0;
    assert!(service.validate().is_err());
}
