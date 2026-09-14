// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

pub use crate::hardware::GIB;
use crate::{Error, config::Service, snapshot::Manifest};
use sha2::{Digest, Sha256};

pub const BACKEND: &str = "vllm-qwen38-spark-v1";
pub const MODEL_NAME: &str = "qwen3.8-flash-next";
pub const RECIPE_REVISION: &str = "d03809008834124e80223c3482f2ddb59577a48f";
pub const PREPARER_SHA256: &str =
    "35da4312f5c9c442eea85445d6f6712c9bb3a3b7c6caccec412da57000b02475";
pub const PREPARED_FILE: &str =
    "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.packed_u8";
pub const PREPARED_BYTES: u64 = 28 * GIB;
pub const VERIFIER_SOURCE: &[u8] = include_bytes!("verify_packed.py");
fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
pub fn model_manifest() -> Manifest {
    serde_json::from_slice(include_bytes!("model.json")).expect("pinned model manifest")
}
pub fn verifier_sha256() -> String {
    hex(Sha256::digest(VERIFIER_SOURCE))
}
pub fn preparation_key() -> String {
    hex(Sha256::digest(format!(
        "{}{}{}{}",
        model_manifest().key(),
        RECIPE_REVISION,
        PREPARER_SHA256,
        verifier_sha256()
    )))
}

mod preparation;
pub use preparation::*;

pub fn gpu_bytes(service: &Service) -> Result<u64, Error> {
    service.validate()?;
    Ok(155 * GIB / 2
        + service.memory.kv_cache_gib as u64 * GIB
        + if service.serving.speculative_tokens > 0 {
            2 * GIB
        } else {
            0
        })
}

pub(crate) fn vllm_settings(
    service: &Service,
) -> Result<crate::backends::vllm::ModelSettings, Error> {
    Ok(crate::backends::vllm::ModelSettings {
        name: MODEL_NAME,
        gpu_bytes: gpu_bytes(service)?,
        kv_cache_dtype: "fp8",
        mamba_cache_dtype: "bfloat16",
        reasoning_parser: "qwen3",
        tool_parser: "qwen3_coder",
        compilation: r#"{"mode":0,"cudagraph_mode":"FULL_DECODE_ONLY","cudagraph_capture_sizes":[1,2,4,8]}"#,
    })
}

pub(crate) fn validate(service: &Service) -> Result<(), crate::config::ConfigError> {
    use crate::config::ConfigError;
    fn require(condition: bool, message: &'static str) -> Result<(), ConfigError> {
        if condition {
            Ok(())
        } else {
            Err(ConfigError(message))
        }
    }
    require(
        service.backend == BACKEND
            && service.model.repository == "Mia-AiLab/Qwen3.8-Flash-Next-NVFP4"
            && service.model.revision == "925d7be6c14c6c9442ef83e8f05b5a3c39304f69",
        "Spark requires qualified backend, pinned model, and immutable image",
    )?;
    let serving = &service.serving;
    require(
        (1024..=65535).contains(&serving.port)
            && (8192..=65536).contains(&serving.context_tokens)
            && (1..=2).contains(&serving.max_sequences)
            && (512..=2048).contains(&serving.batch_tokens)
            && (0..=3).contains(&serving.speculative_tokens)
            && (900..=3600).contains(&serving.startup_timeout_seconds),
        "serving settings exceed qualified Spark bounds",
    )?;
    crate::hardware::Profile::SparkV1.validate_memory(&service.memory)
}
