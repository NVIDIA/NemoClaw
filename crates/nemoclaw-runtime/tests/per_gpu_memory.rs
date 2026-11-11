// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The per-GPU memory contract: a service's GPU budget applies to each GPU it
//! selects, and each selected GPU must match its hardware and have room for
//! that budget. Selected GPUs don't need to be identical.

use nemoclaw_runtime::{
    RuntimeSpec,
    hardware::{Capacity, GIB, nvidia},
    ollama::{ManagedOllama, hardware_capacity as ollama},
    snapshot::{File, Manifest},
    vllm::{Service, hardware_capacity, validation::validate_weights},
};
use serde_json::{Value, json};

const MIB: u64 = 1 << 20;
/// The UUID of the GPU at index 1, which errors name.
const SECOND: &str = "GPU-11111111-0000-0000-0000-000000000000";

/// One `nvidia-smi` row: an H100 with 80 GiB at `index`, `free` GiB free.
fn h100(index: u32, total_gib: u64, free_gib: u64) -> String {
    format!(
        "{index}, GPU-{index}{index}{index}{index}{index}{index}{index}{index}-0000-0000-0000-000000000000, NVIDIA H100 80GB HBM3, 9.0, {}, {}, 580.65",
        total_gib * GIB / MIB,
        free_gib * GIB / MIB
    )
}

/// An AMD64 host whose container sees `rows`, observed as the runtime does.
fn host(rows: &[String]) -> Capacity {
    let mut capacity = Capacity {
        architecture: "amd64".into(),
        total: 512 * GIB,
        available: 400 * GIB,
        free: 300 * GIB,
        disk_free: 500 * GIB,
        ..Default::default()
    };
    nvidia::apply_observations(&mut capacity, &rows.join("\n"), "").unwrap();
    capacity
}

fn vllm(memory: Value, serving: Value) -> Service {
    let mut input = json!({
        "kind": "vllm",
        "hardware": {"profile": "h100", "architecture": "amd64", "minGpuMemoryBytes": 80 * GIB},
        "model": {"repository": "owner/model", "revision": "a".repeat(40)},
        "serving": {"port": 19103, "contextTokens": 8192, "maxSequences": 1,
            "batchTokens": 1024, "startupTimeoutSeconds": 3600},
        "memory": {"hostReserveGiB": 6, "minAvailableGiB": 8, "minFreeGiB": 3,
            "freeGateGiB": 12, "consecutiveSamples": 5}
    });
    for (section, values) in [("memory", memory), ("serving", serving)] {
        for (key, value) in values.as_object().unwrap() {
            input[section][key] = value.clone();
        }
    }
    let RuntimeSpec::Vllm(service) = RuntimeSpec::decode(&input.to_string()).unwrap() else {
        panic!("expected vLLM")
    };
    *service
}

fn ollama_service(memory: Value) -> ManagedOllama {
    let mut input = json!({
        "kind": "ollama",
        "hardware": {"profile": "h100", "architecture": "amd64", "minGpuMemoryBytes": 80 * GIB},
        "model": {"name": "qwen3:0.6b", "digest": "7".repeat(64)},
        "serving": {"port": 11434, "contextTokens": 8192, "maxSequences": 1,
            "startupTimeoutSeconds": 600},
        "memory": {"hostReserveGiB": 6, "minAvailableGiB": 8, "minFreeGiB": 3,
            "freeGateGiB": 12, "consecutiveSamples": 5}
    });
    for (key, value) in memory.as_object().unwrap() {
        input["memory"][key] = value.clone();
    }
    let RuntimeSpec::Ollama(service) = RuntimeSpec::decode(&input.to_string()).unwrap() else {
        panic!("expected Ollama")
    };
    *service
}

fn flag<'a>(arguments: &'a [String], flag: &str) -> Option<&'a str> {
    let index = arguments.iter().position(|argument| argument == flag)?;
    Some(&arguments[index + 1])
}

#[test]
fn a_vllm_budget_applies_to_each_selected_gpu() {
    let service = vllm(json!({"gpuMemoryGiB": 40, "kvCacheGiB": 8}), json!({}));
    let two = host(&[h100(0, 80, 79), h100(1, 80, 79)]);
    hardware_capacity::check_memory(&service, &two, true).unwrap();
    // The second GPU is busy: it has less free memory than the budget.
    let busy = host(&[h100(0, 80, 79), h100(1, 80, 30)]);
    hardware_capacity::check_memory(&service, &busy, false).unwrap();
    let error = hardware_capacity::check_memory(&service, &busy, true)
        .unwrap_err()
        .to_string();
    assert_eq!(
        error,
        format!(
            "{SECOND}: GPU free memory (bytes) requires at least {}; observed {}",
            40 * GIB,
            30 * GIB
        )
    );
}

#[test]
fn a_gpu_without_a_standard_uuid_is_named_by_its_index() {
    let service = vllm(json!({"gpuMemoryGiB": 40, "kvCacheGiB": 8}), json!({}));
    let busy = h100(1, 80, 30).replace(SECOND, "MIG-fixture");
    let error = hardware_capacity::check_memory(&service, &host(&[h100(0, 80, 79), busy]), true)
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with("GPU 1: GPU free memory (bytes)"),
        "{error}"
    );
}

#[test]
fn each_selected_gpu_must_match_the_hardware_profile() {
    let service = vllm(json!({"gpuMemoryGiB": 40, "kvCacheGiB": 8}), json!({}));
    let l4 = "1, GPU-11111111-0000-0000-0000-000000000000, NVIDIA L4, 8.9, 23034, 22000, 580.65";
    let error =
        hardware_capacity::check_memory(&service, &host(&[h100(0, 80, 79), l4.into()]), false)
            .unwrap_err()
            .to_string();
    assert_eq!(
        error,
        format!("{SECOND}: hardware.profile requires H100; observed different GPU family")
    );
    let old_driver = h100(1, 80, 79).replace("580.65", "570.10");
    let error =
        hardware_capacity::check_memory(&service, &host(&[h100(0, 80, 79), old_driver]), false)
            .unwrap_err()
            .to_string();
    assert_eq!(
        error,
        format!("{SECOND}: hardware.minDriverMajor requires at least 580; observed 570")
    );
    // minGpuMemoryBytes applies to each selected GPU.
    let error = hardware_capacity::check_memory(
        &service,
        &host(&[h100(0, 80, 79), h100(1, 64, 60)]),
        false,
    )
    .unwrap_err()
    .to_string();
    assert_eq!(
        error,
        format!(
            "{SECOND}: hardware.minGpuMemoryBytes requires at least {}; observed {}",
            80 * GIB,
            64 * GIB
        )
    );
}

#[test]
fn a_vllm_utilization_applies_to_each_selected_gpus_own_total() {
    let service = vllm(
        json!({"gpuMemoryUtilization": 0.5, "kvCacheGiB": 0}),
        json!({}),
    );
    // Different H100s: vLLM requests half of each GPU's own total.
    let mixed = host(&[h100(0, 80, 79), h100(1, 94, 50)]);
    hardware_capacity::check_memory(&service, &mixed, true).unwrap();
    let busy = host(&[h100(0, 80, 79), h100(1, 94, 46)]);
    let error = hardware_capacity::check_memory(&service, &busy, true)
        .unwrap_err()
        .to_string();
    assert_eq!(
        error,
        format!(
            "{SECOND}: GPU free memory (bytes) requires at least {}; observed {}",
            47 * GIB,
            46 * GIB
        )
    );
    let arguments = service
        .arguments(
            "/data/model",
            hardware_capacity::serving_memory(&service, &mixed).unwrap(),
        )
        .unwrap();
    assert_eq!(flag(&arguments, "--gpu-memory-utilization"), Some("0.5"));
}

#[test]
fn a_fixed_vllm_budget_on_different_gpus_asks_no_gpu_for_more_than_the_budget() {
    let service = vllm(json!({"gpuMemoryGiB": 40, "kvCacheGiB": 8}), json!({}));
    let same = host(&[h100(0, 80, 79), h100(1, 80, 79)]);
    let mixed = host(&[h100(0, 80, 79), h100(1, 160, 150)]);
    let arguments = |capacity: &Capacity| {
        service
            .arguments(
                "/data/model",
                hardware_capacity::serving_memory(&service, capacity).unwrap(),
            )
            .unwrap()
    };
    // vLLM requests the utilization fraction of each GPU's own total free at
    // startup, and sizes its KV cache from --kv-cache-memory-bytes, so the
    // fraction is the budget over the largest selected GPU.
    for (capacity, utilization) in [(&same, "0.500"), (&mixed, "0.250")] {
        let arguments = arguments(capacity);
        assert_eq!(
            flag(&arguments, "--gpu-memory-utilization"),
            Some(utilization)
        );
        assert_eq!(
            flag(&arguments, "--kv-cache-memory-bytes"),
            Some((8 * GIB).to_string().as_str())
        );
    }
}

fn manifest(weights: u64) -> Manifest {
    Manifest {
        repository: "owner/model".into(),
        revision: "a".repeat(40),
        files: vec![
            File {
                name: "model-00001.safetensors".into(),
                size: weights / 2,
                sha256: "0".repeat(64),
            },
            File {
                name: "model-00002.safetensors".into(),
                size: weights - weights / 2,
                sha256: "1".repeat(64),
            },
        ],
    }
}

#[test]
fn weights_count_against_each_gpu_divided_by_the_parallel_layout() {
    // 40 GiB per GPU holds 30 GiB of weights with an 8 GiB KV cache and 2 GiB
    // for the runtime; twice that splits across two GPUs.
    let fits = 30 * GIB;
    for (serving, weights) in [
        (json!({}), fits),
        (json!({"tensorParallelSize": 2}), 2 * fits),
        (json!({"pipelineParallelSize": 2}), 2 * fits),
        (
            json!({"tensorParallelSize": 2, "pipelineParallelSize": 2}),
            4 * fits,
        ),
    ] {
        let service = vllm(
            json!({"gpuMemoryGiB": 40, "kvCacheGiB": 8}),
            serving.clone(),
        );
        validate_weights(&service, &manifest(weights)).unwrap();
        let error = validate_weights(&service, &manifest(weights + 1))
            .unwrap_err()
            .to_string();
        assert!(error.contains("model weights exceed"), "{serving}: {error}");
    }
}

#[test]
fn an_ollama_budget_applies_to_each_selected_gpu() {
    let service = ollama_service(json!({"gpuMemoryGiB": 40}));
    let two = host(&[h100(0, 80, 79), h100(1, 80, 79)]);
    ollama::check_memory(&service, &two, true).unwrap();
    assert_eq!(ollama::budget(&service, &two).unwrap(), 40 * GIB);
    let busy = host(&[h100(0, 80, 79), h100(1, 80, 30)]);
    let error = ollama::check_memory(&service, &busy, true)
        .unwrap_err()
        .to_string();
    assert!(
        error.starts_with(&format!("{SECOND}: GPU free memory (bytes)")),
        "{error}"
    );
    let l4 = "1, GPU-11111111-0000-0000-0000-000000000000, NVIDIA L4, 8.9, 23034, 22000, 580.65";
    assert!(ollama::check_memory(&service, &host(&[h100(0, 80, 79), l4.into()]), false).is_err());
    // Ollama reserves one amount on every GPU, so a utilization fraction is
    // taken of the smallest selected GPU.
    let fraction = ollama_service(json!({"gpuMemoryUtilization": 0.5}));
    let mixed = host(&[h100(0, 80, 79), h100(1, 94, 90)]);
    assert_eq!(ollama::budget(&fraction, &mixed).unwrap(), 40 * GIB);
    ollama::check_memory(&fraction, &mixed, true).unwrap();
}
