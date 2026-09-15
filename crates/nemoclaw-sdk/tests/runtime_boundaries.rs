// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::Document,
    hardware::Profile,
    hardware::{Capacity, GIB},
};
fn service() -> nemoclaw_sdk::config::Service {
    Document::parse(include_str!("fixtures/config/spark.yaml").as_bytes())
        .unwrap()
        .spec
        .inference_providers
        .remove(0)
        .service
        .unwrap()
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
    Profile::SparkV1
        .check_capacity(
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
    let mut wrong_hardware = capacity.clone();
    wrong_hardware.gpu = "other GPU".into();
    assert!(
        Profile::SparkV1
            .check_capacity(&service, &wrong_hardware, true, 0, 0)
            .is_err()
    );
    service.model.revision = "0".repeat(40);
    assert!(service.validate().is_err());
    service = self::service();
    service.backend = "llama.cpp".into();
    assert!(service.validate().is_err());
}
