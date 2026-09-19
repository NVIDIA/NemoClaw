// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Ollama adapter for the shared managed inference contract.
use crate::{
    Error,
    config::{ConfigError, Service, constraints as c},
};
use std::collections::BTreeMap;

pub(crate) fn validate(service: &Service) -> Result<(), ConfigError> {
    service.validate_hardware()?;
    let model = &service.model;
    if !regex::Regex::new(c::OLLAMA_MODEL)
        .unwrap()
        .is_match(&model.name)
        || !regex::Regex::new("^[a-f0-9]{64}$")
            .unwrap()
            .is_match(&model.digest)
        || !model.repository.is_empty()
        || !model.revision.is_empty()
    {
        return Err(ConfigError::new(
            "Ollama requires model.name (library model:tag) and model.digest (manifest SHA-256)",
        ));
    }
    let s = &service.serving;
    if service.recipe.is_some()
        || service.authentication.is_some()
        || !s.model_name.is_empty()
        || !s.tool_parser.is_empty()
        || !s.reasoning_parser.is_empty()
        || !s.mamba_backend.is_empty()
        || s.enforce_eager.is_some()
        || s.batch_tokens != 0
        || s.speculative_tokens != 0
        || service.memory.kv_cache_gib != 0
    {
        return Err(ConfigError::new(
            "Ollama does not support recipes, native bearer authentication, model aliases, vLLM tuning, or explicit KV-cache allocation",
        ));
    }
    if !c::PORT.contains(s.port)
        || !c::CONTEXT_TOKENS.contains(s.context_tokens)
        || !c::MAX_SEQUENCES.contains(s.max_sequences)
        || !c::STARTUP_TIMEOUT.contains(s.startup_timeout_seconds)
        || !(0..=c::GPU_MEMORY_MAX).contains(&service.memory.gpu_memory_gib)
    {
        return Err(ConfigError::new(
            "Ollama serving settings exceed supported bounds",
        ));
    }
    crate::hardware::validate_memory(&service.memory)
}

/// Translate common limits. The runtime also checks observed loaded-model memory;
/// Ollama's scheduling reserve is not an allocator quota.
pub fn environment(
    service: &Service,
    directory: &str,
    total: u64,
    available: Option<u64>,
) -> Result<BTreeMap<String, String>, Error> {
    service.validate()?;
    if service.backend != "ollama" {
        return Err(Error::Conflict("Ollama adapter requires backend ollama"));
    }
    let budget = budget(service, total)?;
    let overhead = if service.dedicated_hardware().is_some() {
        // Ollama subtracts its reserve from free memory, so using total here
        // would count another service's resident allocation twice.
        available
            .filter(|free| *free <= total)
            .and_then(|free| free.checked_sub(budget))
            .ok_or(Error::Conflict(
                "available GPU memory does not satisfy inference budget",
            ))?
    } else {
        0
    };
    Ok([
        ("OLLAMA_HOST", format!("0.0.0.0:{}", service.serving.port)),
        ("OLLAMA_MODELS", directory.into()),
        (
            "OLLAMA_CONTEXT_LENGTH",
            service.serving.context_tokens.to_string(),
        ),
        (
            "OLLAMA_NUM_PARALLEL",
            service.serving.max_sequences.to_string(),
        ),
        ("OLLAMA_MAX_LOADED_MODELS", "1".into()),
        ("OLLAMA_KEEP_ALIVE", "-1".into()),
        ("OLLAMA_GPU_OVERHEAD", overhead.to_string()),
        (
            "OLLAMA_LOAD_TIMEOUT",
            format!("{}s", service.serving.startup_timeout_seconds),
        ),
        ("OLLAMA_NOPRUNE", "true".into()),
        ("OLLAMA_NO_CLOUD", "true".into()),
        ("OLLAMA_VULKAN", "false".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect())
}

pub fn budget(service: &Service, total: u64) -> Result<u64, Error> {
    let budget = service
        .memory
        .gpu_memory_utilization
        .as_ref()
        .and_then(serde_json::Number::as_f64)
        .map_or(service.gpu_bytes()?, |ratio| {
            (total as f64 * ratio).floor() as u64
        });
    if budget == 0 || budget > total {
        return Err(Error::Conflict("invalid total memory for inference budget"));
    }
    Ok(budget)
}
