// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Service, constraints as c};
use crate::{
    Error,
    config::{ConfigError, constraints},
    hardware::GIB,
    snapshot::Manifest,
};
pub(crate) fn gpu_bytes(service: &Service) -> u64 {
    if let Some(recipe) = &service.recipe {
        return recipe.resources.gpu_memory_bytes;
    }
    if let (Some(hardware), Some(ratio)) = (
        service.dedicated_hardware(),
        &service.memory.gpu_memory_utilization,
    ) {
        return (hardware.min_gpu_memory_bytes as f64 * ratio.as_f64().unwrap_or(0.0)).floor()
            as u64;
    }
    (if service.memory.gpu_memory_gib == 0 {
        c::GPU_MEMORY_DEFAULT
    } else {
        service.memory.gpu_memory_gib
    }) as u64
        * GIB
}
pub fn validate(service: &Service) -> Result<(), ConfigError> {
    service.validate_hardware()?;
    super::recipes::huggingface::validate_model(service)?;
    if let Some(recipe) = &service.recipe {
        recipe.validate(service)?;
    }
    let v = &service.serving;
    if (!v.model_name.is_empty()
        && !regex::Regex::new(constraints::MODEL)
            .unwrap()
            .is_match(&v.model_name))
        || !["", "flashinfer"].contains(&v.mamba_backend.as_str())
        || (service.recipe.is_some()
            && (!v.model_name.is_empty()
                || !v.mamba_backend.is_empty()
                || v.enforce_eager.is_some()))
    {
        return Err(ConfigError::new(
            "native serving overrides must be valid and cannot override an inline recipe",
        ));
    }
    if !c::PORT.contains(v.port)
        || !c::CONTEXT_TOKENS.contains(v.context_tokens)
        || !c::MAX_SEQUENCES.contains(v.max_sequences)
        || !c::BATCH_TOKENS.contains(v.batch_tokens)
        || (service.recipe.is_none() && v.speculative_tokens != 0)
        || !(0..=c::SPECULATIVE_TOKENS_MAX).contains(&v.speculative_tokens)
        || !c::STARTUP_TIMEOUT.contains(v.startup_timeout_seconds)
        || !c::TOOL_PARSERS.contains(&v.tool_parser.as_str())
        || !c::REASONING_PARSERS.contains(&v.reasoning_parser.as_str())
    {
        return Err(ConfigError::new(
            "serving settings are unsupported by the generic vLLM backend",
        ));
    }
    super::spark::validate_memory(&service.memory)?;
    if service.recipe.is_some() {
        return Ok(());
    }
    if !(0..=c::GPU_MEMORY_MAX).contains(&service.memory.gpu_memory_gib)
        || gpu_bytes(service) < (service.memory.kv_cache_gib as u64 + 4) * GIB
    {
        return Err(ConfigError::new(
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
