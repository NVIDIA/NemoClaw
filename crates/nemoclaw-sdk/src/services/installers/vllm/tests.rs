// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::arguments;
use crate::{
    config::{Document, ServiceDefinition},
    hardware::GIB,
};

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
