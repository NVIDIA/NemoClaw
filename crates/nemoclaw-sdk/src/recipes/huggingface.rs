// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Model-independent vLLM recipe. Model bytes and identity come from the selected commit.
use crate::{
    Error,
    config::{ConfigError, Service},
    hardware::GIB,
    snapshot::Manifest,
};
use sha2::{Digest, Sha256};
pub const BACKEND: &str = "vllm";
pub const MANIFEST_FILE: &str = ".nemoclaw-manifest.json";
pub fn directory(service: &Service) -> String {
    if let Some(reuse) = service.recipe.as_ref().and_then(|r| r.reuse.as_ref()) {
        return reuse.snapshot_directory.clone();
    }
    let hash = Sha256::digest(format!(
        "{}\0{}",
        service.model.repository, service.model.revision
    ));
    format!(
        "models/{}",
        hash.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
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
    if service.backend != BACKEND {
        return Err(ConfigError("unsupported inference backend"));
    }
    let repository = &service.model.repository;
    if !regex::Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$")
        .unwrap()
        .is_match(repository)
        || repository.len() > 200
        || !regex::Regex::new(r"^[a-f0-9]{40}$")
            .unwrap()
            .is_match(&service.model.revision)
    {
        return Err(ConfigError(
            "model requires a repository and immutable commit revision",
        ));
    }
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
pub fn validate_manifest(service: &Service, manifest: &Manifest) -> Result<(), Error> {
    service.validate()?;
    manifest.validate()?;
    if manifest.repository != service.model.repository
        || manifest.revision != service.model.revision
    {
        return Err(Error::Conflict(
            "snapshot manifest conflicts with selected model",
        ));
    }
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
pub fn decode_manifest(service: &Service, bytes: &[u8]) -> Result<Manifest, Error> {
    let manifest: Manifest = serde_json::from_slice(bytes)
        .map_err(|_| Error::State("invalid retained model manifest"))?;
    validate_manifest(service, &manifest)?;
    Ok(manifest)
}
pub async fn resolve_manifest(service: &Service) -> Result<Manifest, Error> {
    if let Some(manifest) = service.recipe.as_ref().and_then(|r| r.snapshot.as_ref()) {
        validate_manifest(service, manifest)?;
        return Ok(manifest.clone());
    }
    let manifest = crate::snapshot::Client::new()?
        .resolve(&service.model.repository, &service.model.revision)
        .await?;
    validate_manifest(service, &manifest)?;
    Ok(manifest)
}
pub fn arguments(service: &Service, model: &str, total: u64) -> Result<Vec<String>, Error> {
    service.validate()?;
    let budget = gpu_bytes(service);
    if total == 0 || budget > total {
        return Err(Error::Conflict("invalid GPU memory budget"));
    }
    let v = &service.serving;
    let mut args = vec![
        "-m".into(),
        "vllm.entrypoints.openai.api_server".into(),
        "--model".into(),
        model.into(),
        "--served-model-name".into(),
        service.model.repository.clone(),
        "--host".into(),
        "0.0.0.0".into(),
        "--port".into(),
        v.port.to_string(),
        "--tensor-parallel-size".into(),
        "1".into(),
        "--gpu-memory-utilization".into(),
        format!(
            "{:.3}",
            (budget as f64 / total as f64 * 1000.0).floor() / 1000.0
        ),
        "--kv-cache-memory-bytes".into(),
        (service.memory.kv_cache_gib as u64 * GIB).to_string(),
        "--max-model-len".into(),
        v.context_tokens.to_string(),
        "--max-num-seqs".into(),
        v.max_sequences.to_string(),
        "--max-num-batched-tokens".into(),
        v.batch_tokens.to_string(),
        "--load-format".into(),
        "safetensors".into(),
        "--enforce-eager".into(),
    ];
    if !v.tool_parser.is_empty() {
        args.extend([
            "--enable-auto-tool-choice".into(),
            "--tool-call-parser".into(),
            v.tool_parser.clone(),
        ]);
    }
    if !v.reasoning_parser.is_empty() {
        args.extend(["--reasoning-parser".into(), v.reasoning_parser.clone()]);
    }
    Ok(args)
}
