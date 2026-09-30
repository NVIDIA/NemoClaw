// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::ConfigError;
use crate::vllm::{MemoryArchitecture, ServiceHardware};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed GPU Ollama service with an immutable runtime and model snapshot.
pub struct ManagedOllama {
    /// Explicit supported GPU or system profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceHardware")]
    pub hardware: Option<ServiceHardware>,
    /// Selected immutable Ollama registry model.
    pub model: OllamaModel,
    /// Ollama serving limits.
    #[schemars(default)]
    pub serving: OllamaServing,
    /// GPU budget and resident memory-protection thresholds.
    #[schemars(default)]
    pub memory: OllamaMemory,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// One immutable Ollama registry model installation.
pub struct OllamaModel {
    /// Public library model name including its tag.
    pub name: String,
    /// Lowercase SHA-256 of the registry manifest selected for that tag.
    pub digest: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Native Ollama serving controls supported by the managed installer.
pub struct OllamaServing {
    /// Inference listening port.
    #[schemars(default)]
    pub port: i64,
    #[serde(rename = "contextTokens")]
    /// Maximum model context length.
    #[schemars(default)]
    pub context_tokens: i64,
    #[serde(rename = "maxSequences")]
    /// Maximum concurrent sequences.
    #[schemars(default)]
    pub max_sequences: i64,
    #[serde(rename = "startupTimeoutSeconds")]
    /// Seconds allowed for model loading and readiness.
    #[schemars(default)]
    pub startup_timeout_seconds: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Ollama GPU budget and host memory protection.
pub struct OllamaMemory {
    #[serde(
        rename = "gpuMemoryUtilization",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "f64")]
    /// Optional fraction of observed dedicated GPU memory.
    pub gpu_memory_utilization: Option<serde_json::Number>,
    #[serde(rename = "gpuMemoryGiB", skip_serializing_if = "is_zero")]
    #[schemars(default)]
    /// Fixed serving budget in GiB when utilization is omitted. Omission or zero selects 16 GiB.
    pub gpu_memory_gib: i64,
    #[serde(rename = "hostReserveGiB")]
    #[schemars(default)]
    /// Host memory reserve excluded from serving.
    pub host_reserve_gib: i64,
    #[serde(rename = "minAvailableGiB")]
    #[schemars(default)]
    /// Available-memory threshold used by the bounded runtime watchdog.
    pub min_available_gib: i64,
    #[serde(rename = "minFreeGiB")]
    #[schemars(default)]
    /// Free-memory threshold used below freeGateGiB.
    pub min_free_gib: i64,
    #[serde(rename = "freeGateGiB")]
    #[schemars(default)]
    /// Available-memory gate for the free-memory threshold.
    pub free_gate_gib: i64,
    #[serde(rename = "consecutiveSamples")]
    #[schemars(default)]
    /// Consecutive low-memory samples before stopping the owned process.
    pub consecutive_samples: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

impl ManagedOllama {
    pub fn served_model(&self) -> &str {
        &self.model.name
    }

    pub fn defaults(&mut self) {
        for (value, default) in [
            (&mut self.serving.port, super::constraints::PORT.default),
            (
                &mut self.serving.context_tokens,
                super::constraints::CONTEXT_TOKENS.default,
            ),
            (
                &mut self.serving.max_sequences,
                super::constraints::MAX_SEQUENCES.default,
            ),
            (
                &mut self.serving.startup_timeout_seconds,
                super::constraints::STARTUP_TIMEOUT.default,
            ),
            (
                &mut self.memory.host_reserve_gib,
                super::constraints::HOST_RESERVE.default,
            ),
            (
                &mut self.memory.min_available_gib,
                super::constraints::MIN_AVAILABLE.default,
            ),
            (
                &mut self.memory.min_free_gib,
                super::constraints::MIN_FREE.default,
            ),
            (
                &mut self.memory.free_gate_gib,
                super::constraints::FREE_GATE.default,
            ),
            (
                &mut self.memory.consecutive_samples,
                super::constraints::CONSECUTIVE_SAMPLES.default,
            ),
        ] {
            if *value == 0 {
                *value = default;
            }
        }
    }

    pub fn architecture(&self) -> Result<&str, ConfigError> {
        self.hardware
            .as_ref()
            .ok_or_else(|| ConfigError::new("Ollama requires an explicit hardware profile"))?
            .architecture()
    }

    pub fn memory_architecture(&self) -> Result<MemoryArchitecture, ConfigError> {
        match self.hardware.as_ref() {
            Some(ServiceHardware::Dedicated(_)) => Ok(MemoryArchitecture::Dedicated),
            Some(ServiceHardware::Profile { profile, .. }) => Ok(profile.memory_architecture()),
            None => Err(ConfigError::new(
                "Ollama requires an explicit hardware profile",
            )),
        }
    }

    pub fn gpu_bytes(&self) -> Result<u64, crate::Error> {
        let gib = if self.memory.gpu_memory_gib == 0 {
            16
        } else {
            self.memory.gpu_memory_gib
        };
        u64::try_from(gib)
            .ok()
            .and_then(|value| value.checked_mul(crate::hardware::GIB))
            .ok_or(crate::Error::Conflict("invalid Ollama GPU memory budget"))
    }
}
