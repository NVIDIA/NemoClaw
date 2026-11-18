// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::RuntimeSpec;
use serde_json::{Value, json};

fn contract() -> Value {
    json!({
        "kind": "llamaCpp",
        "hardware": {
            "architecture": "amd64", "minComputeCapability": 89,
            "minGpuMemoryBytes": 32_u64 << 30, "minDriverMajor": 580
        },
        "model": {
            "repository": "meta-models/Muse-Glimmer-30B-GGUF",
            "revision": "43c7eadd41352a299ea8e0a36b3157978dd63596",
            "file": "Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf",
            "sha256": "4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e",
            "sizeBytes": 16756683904_u64
        },
        "authentication": "bearer",
        "serving": {"modelName": "muse-glimmer", "contextTokens": 32768},
        "memory": {"gpuMemoryGiB": 32}
    })
}

#[test]
fn pinned_gguf_can_be_decoded_as_a_managed_runtime() {
    let input = contract();
    let decoded = RuntimeSpec::decode(&input.to_string()).expect("managed pinned GGUF runtime");
    let saved = serde_json::to_value(decoded).unwrap();
    assert_eq!(saved["model"], input["model"]);
    assert_eq!(saved["kind"], "llamaCpp");
}

#[test]
fn unsafe_or_mutable_gguf_contracts_are_rejected_without_echoing_values() {
    for (pointer, value) in [
        ("/model/revision", json!("main")),
        ("/model/file", json!("../escape.gguf")),
        ("/model/file", json!("a\\escape.gguf")),
        ("/model/file", json!("/absolute.gguf")),
        ("/model/sha256", json!("wrong-secret-value")),
        ("/model/sizeBytes", json!(0)),
        ("/serving/modelName", json!("--host=evil")),
        ("/serving/contextTokens", json!(0)),
        ("/memory/gpuMemoryGiB", json!(8)),
    ] {
        let mut input = contract();
        *input.pointer_mut(pointer).unwrap() = value;
        let error = RuntimeSpec::decode(&input.to_string())
            .unwrap_err()
            .to_string();
        assert!(
            !error.contains("wrong-secret-value"),
            "diagnostics must not echo input"
        );
    }
}

#[test]
fn launch_uses_local_verified_weights_native_key_file_and_model_template() {
    let RuntimeSpec::LlamaCpp(mut s) = RuntimeSpec::decode(&contract().to_string()).unwrap() else {
        panic!("llama.cpp");
    };
    s.serving.reasoning_strength = Some("low".into());
    let args = s
        .arguments(
            "/data/a path/model.gguf",
            Some("/credentials/inference-key"),
        )
        .unwrap();
    let option = |name| {
        args.windows(2)
            .find(|p| p[0] == name)
            .map(|p| p[1].as_str())
    };
    assert_eq!(option("--model"), Some("/data/a path/model.gguf"));
    assert_eq!(option("--device"), Some("CUDA0"));
    assert_eq!(option("--gpu-layers"), Some("all"));
    assert_eq!(option("--fit"), Some("off"));
    assert_eq!(option("--api-key-file"), Some("/credentials/inference-key"));
    let kwargs: Value = serde_json::from_str(option("--chat-template-kwargs").unwrap()).unwrap();
    assert_eq!(kwargs["reasoning_strength"], "low");
    assert!(s.arguments("/data/model.gguf", None).is_err());
}

#[test]
fn admission_checks_one_gpu_host_headroom_and_remaining_disk() {
    use nemoclaw_runtime::hardware::{Capacity, GIB, Gpu, GpuMemory};
    let RuntimeSpec::LlamaCpp(s) = RuntimeSpec::decode(&contract().to_string()).unwrap() else {
        panic!("llama.cpp");
    };
    let mut c = Capacity {
        architecture: "amd64".into(),
        total: 94 * GIB,
        available: 80 * GIB,
        free: 70 * GIB,
        disk_free: s.model.size_bytes + 16 * GIB,
        ..Capacity::default()
    };
    c.set_gpus(vec![Gpu {
        index: 0,
        uuid: "GPU-test".into(),
        name: "NVIDIA L40S".into(),
        driver_major: 580,
        compute_capability: 89,
        memory: Some(GpuMemory {
            total: 46 * GIB,
            free: 40 * GIB,
        }),
    }]);
    s.check_capacity(&c, true, s.model.size_bytes).unwrap();
    c.disk_free -= 1;
    assert!(s.check_capacity(&c, true, s.model.size_bytes).is_err());
    s.check_capacity(&c, true, 0).unwrap();
    c.gpus[0].memory.as_mut().unwrap().free = 31 * GIB;
    assert!(s.check_memory(&c, true).is_err());
    s.check_memory(&c, false).unwrap();
    c.available = 8 * GIB;
    c.gpus[0].memory.as_mut().unwrap().free = 40 * GIB;
    assert!(s.check_memory(&c, true).is_err());
    c.gpus.clear();
    assert!(s.check_memory(&c, false).is_err());
}
