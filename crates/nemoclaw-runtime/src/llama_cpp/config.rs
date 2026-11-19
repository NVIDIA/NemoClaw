// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Single-GPU llama.cpp runtime. Only public GGUF acquisition is supported.
pub struct LlamaCppService {
    /// Execution hardware observed before acquisition and startup; one NVIDIA CUDA GPU is required.
    pub hardware: crate::vllm::ServiceHardware,
    /// One immutable public GGUF artifact; no model-source credential is resolved.
    pub model: GgufModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Native bearer authentication using a platform-supplied key or retained generated credential.
    pub authentication: Option<crate::vllm::ServiceAuthentication>,
    #[serde(default)]
    /// Native llama-server context, batching, alias and readiness deadline.
    pub serving: LlamaCppServing,
    #[serde(default)]
    /// Declared admission budget and resident host memory protection.
    pub memory: LlamaCppMemory,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Exact immutable public artifact, independently hashed before serving.
pub struct GgufModel {
    /// Public Hugging Face owner/repository containing the GGUF.
    pub repository: String,
    /// Exact lowercase 40-character repository commit; branches and tags are rejected.
    pub revision: String,
    /// Relative .gguf path at that commit; traversal, backslashes and reserved metadata paths are rejected.
    pub file: String,
    /// Lowercase SHA-256 of the complete GGUF, checked on acquisition; warm starts observe verified size and modification time.
    pub sha256: String,
    /// Exact nonzero GGUF byte length, used to bound acquisition and disk requirements.
    pub size_bytes: u64,
}
impl GgufModel {
    pub fn manifest(&self) -> crate::snapshot::Manifest {
        crate::snapshot::Manifest {
            repository: self.repository.clone(),
            revision: self.revision.clone(),
            files: vec![crate::snapshot::File {
                name: self.file.clone(),
                size: self.size_bytes,
                sha256: self.sha256.clone(),
            }],
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
/// Explicit context and batching; full CUDA offload, one slot and f16 KV are fixed.
pub struct LlamaCppServing {
    /// Nonempty model alias advertised in inventory; the agent route must name it.
    pub model_name: String,
    /// Published inference port, from 1024 through 65535.
    pub port: u16,
    /// Context tokens for the single slot, from 8192 through 131072; actual fit needs qualification.
    pub context_tokens: u64,
    /// Maximum logical prompt batch size; omission selects 2048.
    pub batch_tokens: u64,
    /// Physical prompt microbatch, no larger than batchTokens; omission selects 512.
    pub micro_batch_tokens: u64,
    /// Seconds allowed for health and model inventory after launch; omission selects 1800.
    pub startup_timeout_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    /// Optional low, medium or high reasoning_strength argument passed to the embedded Jinja template.
    pub reasoning_strength: Option<String>,
}
impl Default for LlamaCppServing {
    fn default() -> Self {
        Self {
            model_name: String::new(),
            port: 18888,
            context_tokens: 32768,
            batch_tokens: 2048,
            micro_batch_tokens: 512,
            startup_timeout_seconds: 1800,
            reasoning_strength: None,
        }
    }
}
/// llama.cpp admission settings; the default GPU budget is 32 GiB.
pub type LlamaCppMemory = crate::hardware::SingleGpuMemory<32>;
