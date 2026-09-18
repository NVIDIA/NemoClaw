// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! vLLM-specific YAML input owned by the vLLM installer.

use super::constraints;
use crate::{
    config::{ConfigError, ManagedManagement, ManagedResource},
    services::ServiceRuntime,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed vLLM service. Explicit placement and publication must appear together.
pub struct Service {
    /// Optional single NVIDIA GPU requirements on Linux AMD64 with dedicated GPU memory. Omission keeps the existing Spark or inline-recipe host contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceHardware")]
    pub hardware: Option<ServiceHardware>,
    /// Optional managed container IPC and shared-memory settings. Omission uses private IPC and 8 GiB of shared memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceContainer")]
    pub container: Option<ServiceContainer>,
    /// Optional native bearer authentication. The runtime generates and retains the key; omission preserves unauthenticated serving.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceAuthentication")]
    pub authentication: Option<ServiceAuthentication>,
    /// Optional ownership declaration for model storage. Omission means managed; existing retention behavior is unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ManagedResource")]
    pub storage: Option<ManagedResource>,
    /// Optional managed ownership declaration. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ManagedManagement")]
    pub management: Option<ManagedManagement>,
    /// Docker runner and immutable NemoClaw vLLM runtime image.
    pub runtime: ServiceRuntime,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "Box<super::recipes::inline::InlineRecipe>")]
    /// Optional inline preparation and serving contract supplied by the pinned runtime image.
    pub recipe: Option<Box<super::recipes::inline::InlineRecipe>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePlacement")]
    /// SSH Docker placement. Required with an external gateway or Podman sandbox; requires publication.
    #[schemars(extend("x-nemoclaw-required" = "With external gateway or Podman; paired with publication"))]
    pub placement: Option<ServicePlacement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ServicePublication")]
    /// Private inference address reachable by OpenShell. Required with placement.
    #[schemars(extend("x-nemoclaw-required" = "With placement"))]
    pub publication: Option<ServicePublication>,
    /// Public Hugging Face repository and immutable commit.
    pub model: Model,
    #[schemars(default)]
    /// Service limits. Omission selects the SDK defaults; recipe serving settings select recipe-specific parsers and execution options.
    pub serving: Serving,
    #[schemars(default)]
    /// GPU budget and resident watchdog thresholds. Omission selects the SDK defaults.
    pub memory: Memory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
/// Generated bearer authentication for a managed inference service.
pub enum ServiceAuthentication {
    Bearer,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Immutable model identity used for snapshot resolution and storage.
pub struct Model {
    /// Optional ownership declaration for downloading and preparing this model installation. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ManagedManagement")]
    pub management: Option<ManagedManagement>,
    /// Public Hugging Face owner/repository name.
    pub repository: String,
    /// Full lowercase 40-hex commit revision; branches and tags are rejected.
    pub revision: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Limits apply with or without a recipe. Recipe serving settings replace the ordinary service parser settings.
pub struct Serving {
    /// Optional advertised model name without a recipe. Omission uses the model repository; routes must match the advertised name.
    #[serde(rename = "modelName", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub model_name: String,
    /// Native Mamba backend without a recipe. Empty uses vLLM's default; flashinfer selects the pinned image's FlashInfer backend.
    #[serde(rename = "mambaBackend", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    pub mamba_backend: String,
    /// Without a recipe, omission or true enables eager execution; false leaves compilation and CUDA graphs at vLLM's native defaults.
    #[serde(rename = "enforceEager", skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    pub enforce_eager: Option<bool>,
    #[serde(rename = "toolParser", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Native vLLM tool-call parser used when no recipe is declared. Empty omits the parser flag.
    pub tool_parser: String,
    #[serde(rename = "reasoningParser", skip_serializing_if = "String::is_empty")]
    #[schemars(default)]
    /// Native vLLM reasoning parser used when no recipe is declared. Empty omits the parser flag.
    pub reasoning_parser: String,
    #[schemars(default)]
    /// Inference listening port. Explicit publication must use this port.
    pub port: i64,
    #[serde(rename = "contextTokens")]
    #[schemars(default)]
    /// Maximum model context length in tokens.
    pub context_tokens: i64,
    #[serde(rename = "maxSequences")]
    #[schemars(default)]
    /// Maximum concurrent sequences.
    pub max_sequences: i64,
    #[serde(rename = "batchTokens")]
    #[schemars(default)]
    /// Maximum tokens in a scheduled batch.
    pub batch_tokens: i64,
    #[serde(rename = "speculativeTokens")]
    #[schemars(default)]
    /// MTP speculative tokens. Must be zero without a recipe.
    pub speculative_tokens: i64,
    #[serde(rename = "startupTimeoutSeconds")]
    #[schemars(default)]
    /// Seconds allowed for backend readiness before startup fails.
    pub startup_timeout_seconds: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Resident watchdog thresholds are validated before runtime creation. The parser also checks relationships between thresholds.
pub struct Memory {
    /// Optional fraction of observed dedicated GPU memory, from 0.05 through 0.95. Requires service.hardware and excludes a recipe, gpuMemoryGiB and explicit KV-cache allocation; vLLM sizes its cache natively.
    #[serde(
        rename = "gpuMemoryUtilization",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "f64")]
    pub gpu_memory_utilization: Option<serde_json::Number>,
    #[serde(rename = "gpuMemoryGiB", skip_serializing_if = "is_zero")]
    #[schemars(default)]
    /// Total GPU budget in GiB without a recipe. Must be omitted or zero with a recipe, which supplies its own byte budget.
    pub gpu_memory_gib: i64,
    #[serde(rename = "hostReserveGiB")]
    #[schemars(default)]
    /// Host memory reserve in GiB excluded from the serving budget.
    pub host_reserve_gib: i64,
    #[serde(rename = "kvCacheGiB")]
    #[schemars(default)]
    /// KV cache allocation in GiB for ordinary vLLM. Omitted or zero defaults to 8, except gpuMemoryUtilization requires zero and lets vLLM allocate its cache. Recipe serving does not emit this flag.
    pub kv_cache_gib: i64,
    #[serde(rename = "minAvailableGiB")]
    #[schemars(default)]
    /// Available-memory threshold in GiB that contributes a low-memory sample.
    pub min_available_gib: i64,
    #[serde(rename = "minFreeGiB")]
    #[schemars(default)]
    /// Free-memory threshold in GiB, used when available memory is below freeGateGiB.
    pub min_free_gib: i64,
    #[serde(rename = "freeGateGiB")]
    #[schemars(default)]
    /// Available-memory gate in GiB for minFreeGiB. Must be at least minAvailableGiB after defaults.
    pub free_gate_gib: i64,
    #[serde(rename = "consecutiveSamples")]
    #[schemars(default)]
    /// Consecutive low-memory samples before the watchdog stops the owned process.
    pub consecutive_samples: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Execution host and Docker network for a remote model service.
pub struct ServicePlacement {
    /// Optional ownership declaration for the network configured by networkCIDR. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ManagedResource")]
    pub network: Option<ManagedResource>,
    /// Canonical private IPv4 /24 on the selected Docker engine.
    pub network_cidr: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// HTTP model publication must match the bind address, service port, and /v1 path.
pub struct ServicePublication {
    /// Private HTTP inference URL reachable by OpenShell.
    pub endpoint: String,
    /// Private host IPv4 address outside the service Docker subnet. Loopback is rejected.
    pub bind_address: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Requirements for one NVIDIA GPU with dedicated memory on Linux AMD64. Declaring requirements does not qualify a model or host.
pub struct ServiceHardware {
    /// CPU architecture; this dedicated-memory contract requires amd64.
    pub architecture: String,
    /// Minimum NVIDIA compute capability, encoded as major times ten plus minor; 90 means 9.0.
    pub min_compute_capability: u32,
    /// Minimum total dedicated GPU memory in bytes. Host RAM is measured separately.
    pub min_gpu_memory_bytes: u64,
    /// Minimum installed NVIDIA driver major version.
    pub min_driver_major: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed inference IPC and shared-memory settings.
pub struct ServiceContainer {
    /// IPC namespace. Omission uses private; host shares the execution host's IPC namespace.
    #[serde(default)]
    pub ipc: ServiceIpc,
    /// Shared-memory size in GiB, from 1 through 64. Omission uses 8; host IPC uses the host's existing shared-memory mount instead.
    #[serde(default = "default_shm")]
    pub shared_memory_gi_b: u64,
}

fn default_shm() -> u64 {
    8
}

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
/// IPC namespace used by the managed inference container.
pub enum ServiceIpc {
    #[default]
    Private,
    Host,
}

impl Service {
    pub fn served_model(&self) -> &str {
        if let Some(recipe) = &self.recipe {
            return &recipe.serving.model_name;
        }
        if self.serving.model_name.is_empty() {
            &self.model.repository
        } else {
            &self.serving.model_name
        }
    }

    pub fn defaults(&mut self) {
        for (value, default) in [
            (&mut self.serving.port, constraints::PORT.default),
            (
                &mut self.serving.context_tokens,
                constraints::CONTEXT_TOKENS.default,
            ),
            (
                &mut self.serving.max_sequences,
                constraints::MAX_SEQUENCES.default,
            ),
            (
                &mut self.serving.batch_tokens,
                constraints::BATCH_TOKENS.default,
            ),
            (
                &mut self.serving.startup_timeout_seconds,
                constraints::STARTUP_TIMEOUT.default,
            ),
            (
                &mut self.memory.host_reserve_gib,
                constraints::HOST_RESERVE.default,
            ),
            (
                &mut self.memory.kv_cache_gib,
                if self.memory.gpu_memory_utilization.is_some() {
                    0
                } else {
                    constraints::KV_CACHE.default
                },
            ),
            (
                &mut self.memory.min_available_gib,
                constraints::MIN_AVAILABLE.default,
            ),
            (&mut self.memory.min_free_gib, constraints::MIN_FREE.default),
            (
                &mut self.memory.free_gate_gib,
                constraints::FREE_GATE.default,
            ),
            (
                &mut self.memory.consecutive_samples,
                constraints::CONSECUTIVE_SAMPLES.default,
            ),
        ] {
            if *value == 0 {
                *value = default;
            }
        }
    }

    pub(crate) fn runtime_settings(&self) -> Self {
        let mut settings = self.clone();
        settings.management = None;
        settings.storage = None;
        settings.model.management = None;
        if let Some(placement) = &mut settings.placement {
            placement.network = None;
        }
        settings
    }

    pub(crate) fn validate_hardware(&self) -> Result<(), ConfigError> {
        if let Some(h) = &self.hardware
            && (h.architecture != "amd64"
                || !(10..=999).contains(&h.min_compute_capability)
                || !(4 * (1 << 30)..=4 * (1 << 40)).contains(&h.min_gpu_memory_bytes)
                || !(1..=9999).contains(&h.min_driver_major)
                || self.recipe.is_some())
        {
            return Err(ConfigError::new(
                "dedicated GPU requirements must be valid and exclude an inline recipe",
            ));
        }
        if let Some(r) = &self.memory.gpu_memory_utilization
            && (self.hardware.is_none()
                || self.recipe.is_some()
                || self.memory.gpu_memory_gib != 0
                || self.memory.kv_cache_gib != 0
                || r.as_f64().is_none_or(|r| !(0.05..=0.95).contains(&r)))
        {
            return Err(ConfigError::new(
                "GPU utilization requires dedicated hardware and excludes fixed GPU and KV-cache budgets",
            ));
        }
        if self
            .container
            .as_ref()
            .is_some_and(|c| !(1..=64).contains(&c.shared_memory_gi_b))
        {
            return Err(ConfigError::new(
                "shared memory must be between 1 and 64 GiB",
            ));
        }
        Ok(())
    }
}
