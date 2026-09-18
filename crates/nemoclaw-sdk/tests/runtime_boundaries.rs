// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::{Document, ServiceDefinition},
    hardware::{Capacity, GIB},
    services::installers::vllm::{Service, hardware_capacity},
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
fn declared_compatibility_does_not_bypass_capacity_or_memory_policy() {
    let mut service = service();
    let recipe = service.recipe.as_mut().unwrap();
    recipe.compatibility.architecture = "amd64".into();
    recipe.compatibility.gpu = "fixture GPU".into();
    let mut capacity = Capacity {
        architecture: "amd64".into(),
        gpu: "fixture GPU".into(),
        driver_major: 580,
        total: 121 * GIB,
        available: 116 * GIB,
        disk_free: 200 * GIB,
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
