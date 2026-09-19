// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::vllm;
use crate::{config::Document, hardware::GIB};

#[test]
fn ollama_translates_shared_limits_and_checks_snapshot_budget() {
    let mut service =
        Document::parse(include_str!("../../tests/fixtures/config/spark.yaml").as_bytes())
            .unwrap()
            .spec
            .inference_providers
            .remove(0)
            .service
            .unwrap();
    service.backend = "ollama".into();
    service.recipe = None;
    service.hardware = Some(crate::config::ServiceHardware::Profile {
        profile: crate::config::HardwareProfile::H100,
        architecture: Some("amd64".into()),
        min_gpu_memory_bytes: Some(80 * GIB),
    });
    service.model = crate::config::Model {
        name: "qwen3:0.6b".into(),
        digest: "a".repeat(64),
        ..Default::default()
    };
    service.serving = crate::config::Serving::default();
    service.memory = crate::config::Memory::default();
    service.defaults();
    let env =
        super::ollama::environment(&service, "/data/verified", 80 * GIB, Some(80 * GIB)).unwrap();
    assert_eq!(env["OLLAMA_GPU_OVERHEAD"], (64 * GIB).to_string());
    // Another service already uses 32 GiB; reserve only unused memory beyond
    // this service's 16 GiB budget, since Ollama subtracts from free memory.
    let shared =
        super::ollama::environment(&service, "/data/verified", 80 * GIB, Some(48 * GIB)).unwrap();
    assert_eq!(shared["OLLAMA_GPU_OVERHEAD"], (32 * GIB).to_string());
    for available in [None, Some(81 * GIB), Some(15 * GIB)] {
        assert!(
            super::ollama::environment(&service, "/data/verified", 80 * GIB, available).is_err()
        );
    }
    assert_eq!(
        env["OLLAMA_CONTEXT_LENGTH"],
        service.serving.context_tokens.to_string()
    );
    assert_eq!(env["OLLAMA_NUM_PARALLEL"], "1");
    assert_eq!(env["OLLAMA_MODELS"], "/data/verified");
    assert_eq!(env["OLLAMA_NOPRUNE"], "true");
    assert!(super::ollama::environment(&service, "/data/verified", GIB, Some(GIB)).is_err());
    let mut snapshot = crate::snapshot::Manifest {
        repository: "library/qwen3".into(),
        revision: service.model.digest.clone(),
        files: vec![
            crate::snapshot::File {
                name: crate::model_source::native_manifest_path(&service).unwrap(),
                size: 1000,
                sha256: service.model.digest.clone(),
            },
            crate::snapshot::File {
                name: format!("blobs/sha256-{}", "b".repeat(64)),
                size: GIB,
                sha256: "b".repeat(64),
            },
            crate::snapshot::File {
                name: format!("blobs/sha256-{}", "c".repeat(64)),
                size: 1000,
                sha256: "c".repeat(64),
            },
        ],
    };
    crate::model_source::validate_manifest(&service, &snapshot).unwrap();
    snapshot.files[1].size = 20 * GIB;
    assert!(crate::model_source::validate_manifest(&service, &snapshot).is_err());
    service.memory.gpu_memory_utilization = Some(serde_json::Number::from_f64(0.5).unwrap());
    let env =
        super::ollama::environment(&service, "/data/verified", 80 * GIB, Some(80 * GIB)).unwrap();
    assert_eq!(env["OLLAMA_GPU_OVERHEAD"], (40 * GIB).to_string());
    crate::model_source::validate_manifest(&service, &snapshot).unwrap();
}

#[test]
fn vllm_emits_only_selected_recipe_options_and_preserves_basic_defaults() {
    let mut service =
        Document::parse(include_str!("../../tests/fixtures/config/spark.yaml").as_bytes())
            .unwrap()
            .spec
            .inference_providers
            .remove(0)
            .service
            .unwrap();
    let recipe = service.recipe.as_mut().unwrap();
    recipe.serving.lazy_loading = false;
    recipe.serving.chunked_prefill = false;
    recipe.serving.kv_cache_dtype.clear();
    let args = vllm::arguments(&service, "/data/model", 121 * GIB).unwrap();
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
    service.hardware = Some(crate::config::ServiceHardware::Profile {
        profile: crate::config::HardwareProfile::DgxSpark,
        architecture: None,
        min_gpu_memory_bytes: None,
    });
    service.serving.tool_parser = "hermes".into();
    let args = vllm::arguments(&service, "/data/model", 121 * GIB).unwrap();
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
    assert!(vllm::arguments(&service, "/data/model", 0).is_err());
    assert!(vllm::arguments(&service, "/data/model", GIB).is_err());
}
