// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::Document,
    hardware::{Capacity, GIB},
    recipes,
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
    let recipe = recipes::resolve(&service).unwrap();
    assert_eq!(
        recipe.preparation_key(),
        "7490cd95548b14549dd11fe8aa9c48ddea9f3de01a4189785991cb342b827f43"
    );
    let capacity = Capacity {
        architecture: "arm64".into(),
        gpu: "NVIDIA GB10".into(),
        driver_major: 580,
        total: 121 * GIB,
        available: 116 * GIB,
        disk_free: 200 * GIB,
        ..Default::default()
    };
    recipe
        .hardware()
        .check_capacity(
            &service,
            &capacity,
            true,
            recipe.manifest().bytes().unwrap(),
            recipe.prepared_bytes(),
        )
        .unwrap();
    let args = recipe
        .backend()
        .arguments(&service, "/data/model", capacity.total)
        .unwrap();
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--gpu-memory-utilization", "0.706"])
    );
    let expected: Vec<String> =
        serde_json::from_str(include_str!("fixtures/vllm-spark-launch.json")).unwrap();
    assert_eq!(args, expected);
    let mut wrong_hardware = capacity.clone();
    wrong_hardware.gpu = "other GPU".into();
    assert!(
        recipe
            .hardware()
            .check_capacity(&service, &wrong_hardware, true, 0, 0)
            .is_err()
    );
    service.model.revision = "0".repeat(40);
    assert!(recipes::resolve(&service).is_err());
    service = self::service();
    service.backend = "llama.cpp".into();
    assert!(recipes::resolve(&service).is_err());
}
