// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_runtime::RuntimeSpec;
use serde_json::{Value, json};

fn contract() -> Value {
    json!({
        "kind":"nim", "backend":"vllm",
        "hardware":{"architecture":"amd64","minComputeCapability":89,
            "minGpuMemoryBytes":42949672960_u64,"minDriverMajor":580},
        "model":{"name":"meta/llama-3.1-8b-instruct",
            "profile":"092ed4213624e774d24cdaf84e3b6222839bab2008a21d3c214ab46626366f90",
            "minGpuMemoryBytes":33000000000_u64,"cacheBytes":34359738368_u64},
        "authentication":"bearer",
        "serving":{"port":18888,"contextTokens":8192},
        "memory":{"gpuMemoryGiB":40}
    })
}

#[test]
fn pinned_nim_profile_decodes_without_a_literal_download_credential() {
    let input = contract();
    let runtime = RuntimeSpec::decode(&input.to_string()).expect("managed native NIM profile");
    let saved = serde_json::to_value(runtime).unwrap();
    assert_eq!(saved["model"]["profile"], input["model"]["profile"]);
    assert_eq!(saved["kind"], "nim");
}

#[test]
fn tool_parser_accepts_native_names_and_rejects_cli_fragments() {
    for parser in ["llama3_json", "", "x"] {
        let mut input = contract();
        input["model"]["toolParser"] = parser.into();
        RuntimeSpec::decode(&input.to_string()).expect("native parser name");
    }
    for parser in [
        "--host=elsewhere",
        "llama3_json --enable-log-requests",
        "../parser",
        &"x".repeat(65),
    ] {
        let mut input = contract();
        input["model"]["toolParser"] = parser.into();
        assert!(RuntimeSpec::decode(&input.to_string()).is_err());
    }
}

#[test]
fn invalid_profiles_budgets_backends_and_literal_secrets_are_rejected() {
    for (pointer, value) in [
        ("/model/profile", json!("latest")),
        ("/model/name", json!("--host=elsewhere")),
        ("/backend", json!("sglang")),
        ("/model/minGpuMemoryBytes", json!(0)),
        ("/model/cacheBytes", json!(0)),
        ("/memory/gpuMemoryGiB", json!(8)),
        ("/serving/port", json!(65535)),
    ] {
        let mut input = contract();
        *input.pointer_mut(pointer).unwrap() = value;
        assert!(
            RuntimeSpec::decode(&input.to_string()).is_err(),
            "invalid {pointer}"
        );
    }
    let mut input = contract();
    input["ngcApiKey"] = json!("never-echo-this-secret");
    let error = RuntimeSpec::decode(&input.to_string())
        .unwrap_err()
        .to_string();
    assert!(!error.contains("never-echo-this-secret"));
}

#[test]
fn native_profile_admission_requires_gpu_host_headroom_and_cache_reserve() {
    use nemoclaw_runtime::hardware::{Capacity, GIB, Gpu, GpuMemory};
    let RuntimeSpec::Nim(service) = RuntimeSpec::decode(&contract().to_string()).unwrap() else {
        panic!("NIM")
    };
    let mut capacity = Capacity {
        architecture: "amd64".into(),
        total: 128 * GIB,
        available: 100 * GIB,
        free: 80 * GIB,
        disk_free: service.model.cache_bytes + 16 * GIB,
        ..Capacity::default()
    };
    capacity.set_gpus(vec![Gpu {
        index: 0,
        uuid: "GPU-test".into(),
        name: "NVIDIA L40S".into(),
        driver_major: 580,
        compute_capability: 89,
        memory: Some(GpuMemory {
            total: 48 * GIB,
            free: 44 * GIB,
        }),
    }]);
    service.check_capacity(&capacity, true).unwrap();
    capacity.available = 20 * GIB;
    assert!(service.check_capacity(&capacity, true).is_err());
    service.check_capacity(&capacity, false).unwrap();
    capacity.available = 100 * GIB;
    capacity.disk_free -= 1;
    assert!(service.check_capacity(&capacity, true).is_err());
    capacity.disk_free += 1;
    capacity.set_gpus(vec![Gpu {
        index: 0,
        uuid: "GPU-small".into(),
        name: "small".into(),
        driver_major: 580,
        compute_capability: 89,
        memory: Some(GpuMemory {
            total: 24 * GIB,
            free: 24 * GIB,
        }),
    }]);
    assert!(service.check_capacity(&capacity, true).is_err());
}
