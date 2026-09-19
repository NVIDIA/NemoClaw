// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    config::{Document, ServiceDefinition, schema::input_schema},
    hardware::GIB,
    services::installers::vllm::Service,
};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/spark/vllm.yaml")).unwrap();
    let service = &mut value["spec"]["services"]["qwen"];
    *service = json!({
        "kind":"vllm", "authentication":"bearer",
        "image":format!("nc-vllm-amd64@sha256:{}", "0".repeat(64)),
        "model":{"repository":"nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4","revision":"0dcd680e5585c791728c83342b311d0a0026dbeb"},
        "hardware":{"architecture":"amd64","minComputeCapability":90,"minGpuMemoryBytes":96000000000_u64,"minDriverMajor":580},
        "container":{"ipc":"host","sharedMemoryGiB":32},
        "serving":{"modelName":"nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4","contextTokens":65536,"maxSequences":1,"batchTokens":4096,"mambaBackend":"flashinfer","toolParser":"qwen3_coder","reasoningParser":"nemotron_v3","enforceEager":false,"startupTimeoutSeconds":1800},
        "memory":{"gpuMemoryUtilization":0.75}
    });
    value["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["model"] =
        json!("nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4");
    value
}

fn service(document: &Document) -> &Service {
    let ServiceDefinition::Vllm(service) = &document.spec.services["qwen"] else {
        panic!("expected vLLM service");
    };
    service
}

#[test]
fn nemotron_native_serving_settings_preserve_model_identity_and_gpu_fraction() {
    let value = input();
    let doc = Document::parse(value.to_string().as_bytes()).expect("Nemotron service must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    let service = service(&doc);
    let args = service.arguments("/data/model", 96 * GIB).unwrap();
    for pair in [
        [
            "--served-model-name",
            "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4",
        ],
        ["--gpu-memory-utilization", "0.75"],
        ["--max-num-batched-tokens", "4096"],
        ["--mamba-backend", "flashinfer"],
        ["--reasoning-parser", "nemotron_v3"],
        ["--tool-call-parser", "qwen3_coder"],
    ] {
        assert!(args.windows(2).any(|p| p == pair), "{pair:?}");
    }
    assert!(args.iter().any(|a| a == "--enable-auto-tool-choice"));
    assert!(
        !args
            .iter()
            .any(|a| a == "--enforce-eager" || a == "--kv-cache-memory-bytes")
    );
    assert!(service.recipe.is_none());
}

#[test]
fn dedicated_gpu_checks_use_vram_and_preserve_host_memory_protection() {
    use nemoclaw_sdk::{
        hardware::{Capacity, GpuMemory},
        services::installers::vllm::hardware_capacity::check_capacity,
    };
    let doc = Document::parse(input().to_string().as_bytes()).unwrap();
    let service = service(&doc);
    let capacity = Capacity {
        architecture: "amd64".into(),
        gpu: "NVIDIA fixture GPU".into(),
        driver_major: 580,
        total: 256 * GIB,
        available: 200 * GIB,
        free: 100 * GIB,
        disk_free: 500 * GIB,
        compute_capability: 90,
        gpu_memory: Some(GpuMemory {
            total: 96 * GIB,
            free: 90 * GIB,
        }),
        ..Default::default()
    };
    check_capacity(service, &capacity, true, 0, 0).expect("qualified dedicated GPU must pass");
    for invalid in ["vram", "free", "compute", "driver", "host", "missing"] {
        let mut c = capacity.clone();
        match invalid {
            "vram" => {
                let gpu = c.gpu_memory.as_mut().unwrap();
                gpu.total = 80 * GIB;
                gpu.free = 80 * GIB;
            }
            "free" => c.gpu_memory.as_mut().unwrap().free = 60 * GIB,
            "compute" => c.compute_capability = 89,
            "driver" => c.driver_major = 579,
            "host" => c.available = 20 * GIB,
            "missing" => c.gpu_memory = None,
            _ => unreachable!(),
        }
        assert!(
            check_capacity(service, &c, true, 0, 0).is_err(),
            "{invalid}"
        );
    }
    let mut shared = capacity.clone();
    shared.foreign_gpu_processes = 1;
    check_capacity(service, &shared, true, 0, 0).unwrap();
    // A running service legitimately uses its GPU allocation. Refresh still
    // checks total capacity, without requiring the startup allocation to be free.
    let mut running = capacity;
    running.gpu_memory.as_mut().unwrap().free = GIB;
    running.foreign_gpu_processes = 1;
    check_capacity(service, &running, false, 0, 0).unwrap();
}

#[test]
fn native_serving_schema_rejects_ambiguous_budgets_and_unsafe_overrides() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for (pointer, value) in [
        ("/spec/services/qwen/hardware/architecture", json!("arm64")),
        ("/spec/services/qwen/hardware/minGpuMemoryBytes", json!(0)),
        (
            "/spec/services/qwen/hardware/minComputeCapability",
            json!(0),
        ),
        (
            "/spec/services/qwen/container/ipc",
            json!("container:foreign"),
        ),
        ("/spec/services/qwen/container/sharedMemoryGiB", json!(0)),
        ("/spec/services/qwen/memory/gpuMemoryUtilization", json!(1)),
        (
            "/spec/services/qwen/serving/modelName",
            json!("invalid model name"),
        ),
        (
            "/spec/services/qwen/serving/mambaBackend",
            json!("arbitrary"),
        ),
    ] {
        let mut bad = input();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(
            Document::parse(bad.to_string().as_bytes()).is_err(),
            "{pointer}"
        );
        assert!(!schema.is_valid(&bad), "{pointer}");
    }
    for field in ["gpuMemoryGiB", "kvCacheGiB"] {
        let mut bad = input();
        bad["spec"]["services"]["qwen"]["memory"][field] = json!(8);
        assert!(Document::parse(bad.to_string().as_bytes()).is_err());
        assert!(!schema.is_valid(&bad));
    }
    let mut bad = input();
    bad["spec"]["services"]["qwen"]
        .as_object_mut()
        .unwrap()
        .remove("hardware");
    assert!(Document::parse(bad.to_string().as_bytes()).is_err());
    assert!(!schema.is_valid(&bad));
}

#[test]
fn native_container_contract_and_remote_example_preserve_declared_settings() {
    use nemoclaw_sdk::{compile, managed::Spec};
    let doc =
        Document::parse(include_str!("../../../examples/nemotron-amd64.yaml").as_bytes()).unwrap();
    let generations = ["managed_gateway", "inference_service"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    let targets = compile::runtime_targets(&doc, &generations).unwrap();
    let spec: Spec = serde_json::from_str(
        &targets
            .iter()
            .find(|t| t.kind == "inference_service")
            .unwrap()
            .values["spec"],
    )
    .unwrap();
    let container = serde_json::to_value(spec.container("/data").unwrap()).unwrap();
    assert_eq!(container["HostConfig"]["IpcMode"], "host");
    assert_eq!(container["HostConfig"]["ShmSize"], 32 * GIB);
    let runtime_definition: ServiceDefinition =
        serde_json::from_str(spec.runtime_configuration().unwrap()).unwrap();
    let ServiceDefinition::Vllm(runtime_service) = runtime_definition else {
        panic!("expected vLLM runtime configuration");
    };
    assert_eq!(
        runtime_service
            .hardware
            .as_ref()
            .unwrap()
            .architecture()
            .unwrap(),
        "amd64"
    );
    assert!(runtime_service.placement.is_none());
    assert!(runtime_service.arguments("/data/model", 80 * GIB).is_err());
    assert!(!container.to_string().contains("VLLM_API_KEY"));
    let mut fractional = input();
    fractional["spec"]["services"]["qwen"]["memory"]["gpuMemoryUtilization"] = json!(0.7555);
    let doc = Document::parse(fractional.to_string().as_bytes()).unwrap();
    let args = service(&doc).arguments("/data/model", 96 * GIB).unwrap();
    assert!(
        args.windows(2)
            .any(|p| p == ["--gpu-memory-utilization", "0.7555"])
    );
}

#[test]
fn qwen_xml_tools_reach_the_native_server_without_changing_reasoning() {
    let mut value = input();
    value["spec"]["services"]["qwen"]["serving"]["toolParser"] = json!("qwen3_xml");
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let args = service(&document)
        .arguments("/data/model", 96 * GIB)
        .unwrap();
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--tool-call-parser", "qwen3_xml"])
    );
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--reasoning-parser", "nemotron_v3"])
    );
    assert!(args.iter().any(|arg| arg == "--enable-auto-tool-choice"));
}
