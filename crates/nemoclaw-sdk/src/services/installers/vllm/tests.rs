// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Service, arguments};
use crate::{
    config::{Document, ServiceDefinition},
    hardware::{Capacity, GIB},
};

fn service() -> Service {
    let mut document =
        Document::parse(include_str!("../../../../tests/fixtures/config/spark.yaml").as_bytes())
            .unwrap();
    let ServiceDefinition::Vllm(service) = document.spec.services.remove("qwen").unwrap() else {
        panic!("expected vLLM service");
    };
    *service
}

#[test]
fn capacity_rejects_unsafe_startup_without_allocating_host_memory() {
    let service = service();
    let good = Capacity {
        architecture: "arm64".into(),
        gpu: "NVIDIA GB10".into(),
        driver_major: 580,
        compute_capability: 121,
        gpu_memory: None,
        total: 121 * GIB,
        available: 116 * GIB,
        free: 110 * GIB,
        disk_free: 200 * GIB,
        foreign_gpu_processes: 0,
    };
    let download = service
        .recipe
        .as_ref()
        .unwrap()
        .snapshot
        .as_ref()
        .unwrap()
        .bytes()
        .unwrap();
    let prepared = service.recipe.as_ref().unwrap().resources.prepared_bytes;
    service
        .check_capacity(&good, true, download, prepared)
        .unwrap();
    let mut cached = good.clone();
    cached.free = GIB;
    service
        .check_capacity(&cached, true, download, prepared)
        .unwrap();
    for dimension in ["memory", "disk", "gpu", "architecture", "driver", "reserve"] {
        let mut bad = good.clone();
        let mut spec = service.clone();
        match dimension {
            "memory" => bad.available = 60 * GIB,
            "disk" => bad.disk_free = 40 * GIB,
            "gpu" => bad.gpu = "unknown".into(),
            "architecture" => bad.architecture = "amd64".into(),
            "driver" => bad.driver_major = 570,
            "reserve" => spec.memory.host_reserve_gib = 64,
            _ => unreachable!(),
        }
        assert!(
            spec.check_capacity(&bad, true, download, prepared).is_err(),
            "{dimension}"
        );
    }
    let mut shared = good.clone();
    shared.foreign_gpu_processes = 1;
    service
        .check_capacity(&shared, true, download, prepared)
        .expect("existing GPU users are accounted for by measured available memory");
    let mut running = good;
    running.available = 20 * GIB;
    running.foreign_gpu_processes = 1;
    service.check_capacity(&running, false, 0, 0).unwrap();
}

#[test]
fn vllm_emits_only_selected_recipe_options_and_preserves_basic_defaults() {
    let mut document =
        Document::parse(include_str!("../../../../tests/fixtures/config/spark.yaml").as_bytes())
            .unwrap();
    let ServiceDefinition::Vllm(mut service) = document.spec.services.remove("qwen").unwrap()
    else {
        panic!("expected vLLM service");
    };
    let recipe = service.recipe.as_mut().unwrap();
    recipe.serving.lazy_loading = false;
    recipe.serving.chunked_prefill = false;
    recipe.serving.kv_cache_dtype.clear();
    let args = arguments::arguments(&service, "/data/model", 121 * GIB).unwrap();
    for flag in [
        "--safetensors-load-strategy",
        "--enable-chunked-prefill",
        "--kv-cache-dtype",
        "--mamba-ssm-cache-dtype",
        "--reasoning-parser",
        "--tool-call-parser",
        "--enable-auto-tool-choice",
        "--enforce-eager",
    ] {
        assert!(!args.iter().any(|v| v == flag), "{flag}");
    }
    assert!(
        args.windows(2)
            .any(|v| v == ["--compilation-config", "{\"mode\":0}"])
    );
    assert!(!args.iter().any(String::is_empty));
    service.recipe = None;
    service.hardware = Some(
        crate::services::installers::vllm::ServiceHardware::Profile {
            profile: crate::services::installers::vllm::HardwareProfile::DgxSpark,
            architecture: None,
            min_gpu_memory_bytes: None,
        },
    );
    service.serving.tool_parser = "hermes".into();
    let args = arguments::arguments(&service, "/data/model", 121 * GIB).unwrap();
    assert!(args.iter().any(|v| v == "--enforce-eager"));
    assert!(
        args.windows(2)
            .any(|v| v == ["--tool-call-parser", "hermes"])
    );
    assert!(
        args.windows(2)
            .any(|v| v == ["--kv-cache-memory-bytes", "8589934592"])
    );
    assert!(!args.iter().any(|v| v == "--compilation-config"));
    assert!(arguments::arguments(&service, "/data/model", 0).is_err());
    assert!(arguments::arguments(&service, "/data/model", GIB).is_err());
}
