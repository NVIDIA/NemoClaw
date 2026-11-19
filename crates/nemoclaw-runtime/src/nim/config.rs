// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// Native backend supported by the managed NIM authentication contract.
pub enum NimBackend {
    /// Native vLLM with bearer authentication supplied through VLLM_API_KEY.
    Vllm,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One native NIM profile. The image must contain the v1 supervisor and a vLLM backend.
pub struct NimService {
    /// Explicit native backend; other NIM engines are unsupported.
    pub backend: NimBackend,
    /// Required GPU and execution-host compatibility.
    pub hardware: crate::vllm::ServiceHardware,
    /// Exact native model and embedded profile.
    pub model: NimModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    /// Native vLLM bearer authentication; the published listener filters management routes.
    pub authentication: Option<crate::vllm::ServiceAuthentication>,
    #[serde(default)]
    /// Native ports, context length, and startup wait.
    pub serving: NimServing,
    #[serde(default)]
    /// GPU budget and host memory protection.
    pub memory: NimMemory,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Native model profile, GPU memory floor, and cache allowance.
pub struct NimModel {
    #[schemars(regex(pattern=crate::schema::MODEL),length(min=1,max=200))]
    /// Exact name advertised by NIM and used by the inference route.
    pub name: String,
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    /// Native profile identifier from this image's embedded manifest.
    pub profile: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[schemars(regex(pattern = "^[a-z0-9_]*$"), length(max = 64))]
    /// Native vLLM tool parser; a nonempty name enables auto tool choice. Omission leaves native defaults. Match the parser to the model and pinned image.
    pub tool_parser: String,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    /// Native vLLM default chat-template arguments, passed as JSON. Omission retains native defaults; request-level arguments take precedence.
    pub chat_template_kwargs: std::collections::BTreeMap<String, serde_json::Value>,
    #[schemars(range(min = 1, max = 1099511627776_u64))]
    /// Profile's upstream memory floor, in bytes; include activation headroom in the budget.
    pub min_gpu_memory_bytes: u64,
    #[schemars(range(min = 1, max = 1099511627776_u64))]
    /// Full cache disk allowance in bytes, excluding 16 GiB of working headroom.
    pub cache_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
/// Native listener and generation settings; the public route filter uses the same serving port.
pub struct NimServing {
    #[schemars(range(min = 1024, max = 65534))]
    /// Native listener on the private model network; the next port is reserved for its backend.
    pub port: u16,
    #[schemars(range(min = 1024, max = 131072))]
    /// Maximum prompt plus generated token count.
    pub context_tokens: u64,
    #[schemars(range(min = 60, max = 7200))]
    /// Maximum native startup wait in seconds, including profile/cache preparation.
    pub startup_timeout_seconds: u64,
}
impl Default for NimServing {
    fn default() -> Self {
        Self {
            port: 18888,
            context_tokens: 8192,
            startup_timeout_seconds: 2400,
        }
    }
}

/// Native NIM memory settings; the default GPU budget is 40 GiB.
pub type NimMemory = crate::hardware::SingleGpuMemory<40>;
