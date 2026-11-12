// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Service, arguments};
use crate::config::{Document, ServiceDefinition};
use nemoclaw_runtime::hardware::{Capacity, GIB, Gpu};

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
    let mut good = Capacity {
        architecture: "arm64".into(),
        total: 121 * GIB,
        available: 116 * GIB,
        free: 110 * GIB,
        disk_free: 200 * GIB,
        foreign_gpu_processes: 0,
        ..Default::default()
    };
    good.set_gpus(vec![Gpu {
        index: 0,
        uuid: "GPU-00000000-0000-0000-0000-000000000000".into(),
        name: "NVIDIA GB10".into(),
        driver_major: 580,
        compute_capability: 121,
        memory: None,
    }]);
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
            "gpu" => bad.gpus[0].name = "unknown".into(),
            "architecture" => bad.architecture = "amd64".into(),
            "driver" => bad.gpus[0].driver_major = 570,
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

#[test]
fn every_runtime_contract_setting_has_an_opentofu_attribute() {
    use crate::hcl_schema::Shape;
    let fields = super::runtime_fields().expect("every vLLM runtime construct maps to OpenTofu");
    assert_eq!(
        fields.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "authentication",
            "hardware",
            "memory",
            "model",
            "recipe",
            "serving"
        ]
    );
    assert!(fields["model"].required);
    let object = |shape: &Shape| match shape {
        Shape::Object(fields) => fields.clone(),
        other => panic!("expected an object, found {other:?}"),
    };
    assert!(object(&fields["serving"].shape).contains_key("model_name"));
    assert!(object(&fields["memory"].shape).contains_key("gpu_memory_gib"));
    let hardware = object(&fields["hardware"].shape);
    assert!(hardware.contains_key("profile") && hardware.contains_key("min_driver_major"));
    let recipe = object(&fields["recipe"].shape);
    assert!(recipe["api_version"].required);
    let snapshot = object(&recipe["snapshot"].shape);
    assert!(matches!(snapshot["files"].shape, Shape::ObjectList(_)));
}

#[test]
fn bearer_vllm_listens_on_loopback_beside_the_published_port_with_otherwise_unchanged_arguments() {
    let after = |arguments: &[String], flag: &str| {
        arguments
            .iter()
            .position(|argument| argument == flag)
            .unwrap()
            + 1
    };
    let mut service = service();
    for (port, backend) in [(18888, "18889"), (65535, "65534")] {
        service.serving.port = port;
        service.authentication = None;
        let mut expected = arguments::arguments(&service, "/data/model", 121 * GIB).unwrap();
        let (host, listen) = (after(&expected, "--host"), after(&expected, "--port"));
        assert_eq!(expected[host], "0.0.0.0");
        assert_eq!(expected[listen], port.to_string());
        // Bearer vLLM listens only on loopback, behind the supervisor's route
        // filter on the published port; nothing else in its launch changes.
        expected[host] = "127.0.0.1".into();
        expected[listen] = backend.into();
        service.authentication = Some(super::ServiceAuthentication::Bearer);
        let bearer = arguments::arguments(&service, "/data/model", 121 * GIB).unwrap();
        assert_eq!(bearer, expected, "{port}");
    }
}

#[test]
fn bearer_docker_install_requires_an_image_that_restricts_routes() {
    let document =
        Document::parse(include_str!("../../../../tests/fixtures/config/spark.yaml").as_bytes())
            .unwrap();
    let mut service = service();
    let generations = [(super::SERVICE_KIND.into(), "a".repeat(32))].into();
    service.authentication = Some(super::ServiceAuthentication::Bearer);
    let spec = super::specification(&document, "qwen", &service, &generations).unwrap();
    let labels = spec.process.unwrap().image_labels;
    assert_eq!(
        labels
            .get("org.nemoclaw.inference.authentication")
            .map(String::as_str),
        Some("bearer-v1")
    );
    assert_eq!(
        labels
            .get("org.nemoclaw.inference.routes")
            .map(String::as_str),
        Some("openai-v2")
    );
    service.authentication = None;
    let spec = super::specification(&document, "qwen", &service, &generations).unwrap();
    assert!(
        !spec
            .process
            .unwrap()
            .image_labels
            .contains_key("org.nemoclaw.inference.routes")
    );
}

/// The value vLLM receives for `flag`.
fn flag<'a>(arguments: &'a [String], flag: &str) -> &'a str {
    let index = arguments
        .iter()
        .position(|argument| argument == flag)
        .unwrap_or_else(|| panic!("{flag} is missing from {arguments:?}"));
    &arguments[index + 1]
}

#[test]
fn vllm_gets_the_parallel_layout_of_the_service_or_its_recipe() {
    let layout = |service: &Service| {
        let arguments = arguments::arguments(service, "/data/model", 121 * GIB).unwrap();
        (
            flag(&arguments, "--tensor-parallel-size").to_owned(),
            flag(&arguments, "--pipeline-parallel-size").to_owned(),
        )
    };
    let mut service = service();
    assert_eq!(layout(&service), ("1".into(), "1".into()));
    // A recipe's layout is its own: an omitted size gets vLLM's default of 1,
    // whatever GPUs the service selects.
    service.container =
        Some(serde_json::from_value(serde_json::json!({ "gpuDevices": ["0", "1"] })).unwrap());
    assert_eq!(layout(&service), ("1".into(), "1".into()));
    let recipe = service.recipe.as_mut().unwrap();
    recipe.serving.pipeline_parallel_size = Some(2);
    assert_eq!(layout(&service), ("1".into(), "2".into()));
    let recipe = service.recipe.as_mut().unwrap();
    recipe.serving.tensor_parallel_size = Some(4);
    assert_eq!(layout(&service), ("4".into(), "2".into()));
    service.container = None;

    service.recipe = None;
    service.hardware = Some(super::ServiceHardware::Profile {
        profile: super::HardwareProfile::DgxSpark,
        architecture: None,
        min_gpu_memory_bytes: None,
    });
    assert_eq!(layout(&service), ("1".into(), "1".into()));
    // NemoClaw passes the layout as written; vLLM checks it against the GPUs
    // it sees and the model.
    service.serving.tensor_parallel_size = Some(4);
    service.serving.pipeline_parallel_size = Some(3);
    assert_eq!(layout(&service), ("4".into(), "3".into()));
}

#[test]
fn tensor_parallelism_defaults_to_the_selected_gpus_without_a_pipeline_size() {
    let document =
        Document::parse(include_str!("../../../../tests/fixtures/config/spark.yaml").as_bytes())
            .unwrap();
    let generations = [(super::SERVICE_KIND.into(), "a".repeat(32))].into();
    let layout = |service: &Service| {
        let spec = super::specification(&document, "qwen", service, &generations).unwrap();
        let serving = super::configured_service(&spec).unwrap().serving;
        (serving.tensor_parallel_size, serving.pipeline_parallel_size)
    };
    let devices = |devices: serde_json::Value| {
        Some(serde_json::from_value(serde_json::json!({ "gpuDevices": devices })).unwrap())
    };
    let mut service = service();
    service.recipe = None;
    service.hardware = Some(super::ServiceHardware::Profile {
        profile: super::HardwareProfile::DgxSpark,
        architecture: None,
        min_gpu_memory_bytes: None,
    });
    for (container, expected) in [
        (None, 1),
        (devices(serde_json::json!(["0"])), 1),
        (devices(serde_json::json!(["0", "1"])), 2),
        (devices(serde_json::json!(["0", "1", "2", "3"])), 4),
    ] {
        service.container = container;
        assert_eq!(layout(&service), (Some(expected), None));
    }
    // With only a pipeline size, the tensor size stays at vLLM's default of 1,
    // so two GPUs get pipeline parallelism 2 rather than a layout of 4.
    service.container = devices(serde_json::json!(["0", "1"]));
    service.serving.pipeline_parallel_size = Some(2);
    assert_eq!(layout(&service), (Some(1), Some(2)));
    // An explicit size stays as written.
    service.serving.tensor_parallel_size = Some(1);
    service.serving.pipeline_parallel_size = None;
    assert_eq!(layout(&service), (Some(1), None));
}
