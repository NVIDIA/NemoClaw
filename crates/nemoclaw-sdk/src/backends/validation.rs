// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    config::{ConfigError, Service},
    hardware::GIB,
    snapshot::Manifest,
};
pub(crate) fn gpu_bytes(service: &Service) -> u64 {
    if let Some(recipe) = &service.recipe {
        return recipe.resources.gpu_memory_bytes;
    }
    (if service.memory.gpu_memory_gib == 0 {
        16
    } else {
        service.memory.gpu_memory_gib
    }) as u64
        * GIB
}
pub fn validate(service: &Service) -> Result<(), ConfigError> {
    if service.backend != "vllm" {
        return Err(ConfigError("unsupported inference backend"));
    }
    crate::recipes::huggingface::validate_model(service)?;
    if let Some(recipe) = &service.recipe {
        recipe.validate(service)?;
    }
    let v = &service.serving;
    if !(1024..=65535).contains(&v.port)
        || !(8192..=65536).contains(&v.context_tokens)
        || !(1..=2).contains(&v.max_sequences)
        || !(512..=2048).contains(&v.batch_tokens)
        || (service.recipe.is_none() && v.speculative_tokens != 0)
        || !(0..=3).contains(&v.speculative_tokens)
        || !(60..=3600).contains(&v.startup_timeout_seconds)
        || !matches!(
            v.tool_parser.as_str(),
            "" | "hermes" | "qwen3_coder" | "llama3_json" | "mistral"
        )
        || !matches!(v.reasoning_parser.as_str(), "" | "qwen3" | "deepseek_r1")
    {
        return Err(ConfigError(
            "serving settings are unsupported by the generic vLLM backend",
        ));
    }
    crate::hardware::Profile::SparkV1.validate_memory(&service.memory)?;
    if service.recipe.is_some() {
        return Ok(());
    }
    if !(0..=96).contains(&service.memory.gpu_memory_gib)
        || gpu_bytes(service) < (service.memory.kv_cache_gib as u64 + 4) * GIB
    {
        return Err(ConfigError(
            "GPU memory budget must include KV cache and at least 4 GiB for model and runtime",
        ));
    }
    Ok(())
}
pub(crate) fn validate_weights(service: &Service, manifest: &Manifest) -> Result<(), Error> {
    if service.recipe.is_some() {
        return Ok(());
    }
    let weights: u64 = manifest
        .files
        .iter()
        .filter(|f| f.name.ends_with(".safetensors"))
        .map(|f| f.size)
        .sum();
    if weights == 0
        || weights
            .checked_add((service.memory.kv_cache_gib as u64 + 2) * GIB)
            .is_none_or(|bytes| bytes > gpu_bytes(service))
    {
        return Err(Error::Conflict(
            "model weights exceed the declared GPU memory budget",
        ));
    }
    Ok(())
}
