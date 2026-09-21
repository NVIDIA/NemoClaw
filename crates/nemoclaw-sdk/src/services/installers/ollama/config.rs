// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::super::vllm::{
    DedicatedHardware, MemoryArchitecture, ServiceContainer, ServiceHardware, ServicePlacement,
    ServicePublication,
};
use crate::config::{
    ConfigError, ImagePullPolicy, InferenceApi, InferenceProvider, constraints, validate_endpoint,
};
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
    /// Optional IPC and shared-memory settings for the runtime container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceContainer")]
    pub container: Option<ServiceContainer>,
    /// Registry image pinned by digest, or a local Docker image ID with imagePullPolicy Never and no placement.
    pub image: String,
    /// Image acquisition before container creation. Omission means IfNotPresent.
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Optional remote Docker placement. Requires publication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServicePlacement")]
    pub placement: Option<ServicePlacement>,
    /// Private inference address for an explicitly placed service.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServicePublication")]
    pub publication: Option<ServicePublication>,
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
            (&mut self.serving.port, 18888),
            (&mut self.serving.context_tokens, 32768),
            (&mut self.serving.max_sequences, 1),
            (&mut self.serving.startup_timeout_seconds, 1800),
            (&mut self.memory.host_reserve_gib, 32),
            (&mut self.memory.min_available_gib, 8),
            (&mut self.memory.min_free_gib, 3),
            (&mut self.memory.free_gate_gib, 12),
            (&mut self.memory.consecutive_samples, 5),
        ] {
            if *value == 0 {
                *value = default;
            }
        }
    }

    pub(crate) fn runtime_settings(&self) -> Self {
        let mut settings = self.clone();
        settings.image_pull_policy = None;
        settings
    }

    pub(crate) fn architecture(&self) -> Result<&str, ConfigError> {
        self.hardware
            .as_ref()
            .ok_or_else(|| ConfigError::new("Ollama requires an explicit hardware profile"))?
            .architecture()
    }

    pub(crate) fn memory_architecture(&self) -> Result<MemoryArchitecture, ConfigError> {
        match self.hardware.as_ref() {
            Some(ServiceHardware::Dedicated(_)) => Ok(MemoryArchitecture::Dedicated),
            Some(ServiceHardware::Profile { profile, .. }) => Ok(profile.memory_architecture()),
            None => Err(ConfigError::new(
                "Ollama requires an explicit hardware profile",
            )),
        }
    }

    pub(crate) fn dedicated_hardware(&self) -> Option<DedicatedHardware> {
        match self.hardware.as_ref()? {
            ServiceHardware::Dedicated(hardware) => Some(hardware.clone()),
            hardware @ ServiceHardware::Profile {
                profile,
                min_gpu_memory_bytes,
                ..
            } if profile.memory_architecture() == MemoryArchitecture::Dedicated => {
                Some(DedicatedHardware {
                    architecture: hardware.architecture().ok()?.into(),
                    min_compute_capability: profile.compute_capability(),
                    min_gpu_memory_bytes: min_gpu_memory_bytes.unwrap_or(4 * (1 << 30)),
                    min_driver_major: 580,
                })
            }
            _ => None,
        }
    }

    pub(crate) fn gpu_bytes(&self) -> Result<u64, crate::Error> {
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed authenticated proxy for an external, loopback-only Ollama daemon and installed model.
pub struct OllamaProxy {
    /// Local Docker Unix socket. Omission uses the managed gateway engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String", regex(pattern = r"^unix:///[^?#\x00]*$"))]
    pub engine: Option<String>,
    /// Registry image pinned by digest, or a local Docker image ID with imagePullPolicy Never. The external daemon runs on the selected Docker host.
    pub image: String,
    /// Image acquisition before container creation. Omission means IfNotPresent.
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Private or loopback HTTP IPv4:port/v1 published by the proxy and reachable by OpenShell.
    pub endpoint: String,
    /// External loopback-only daemon and already-installed model.
    pub upstream: ExternalOllama,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// External Ollama daemon observed by the managed proxy installer.
pub struct ExternalOllama {
    /// Loopback-only Ollama HTTP endpoint ending in /v1.
    pub endpoint: String,
    /// Existing model verified before the proxy starts.
    pub model: ExternalOllamaModel,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Existing Ollama model installation, independently owned outside the deployment.
pub struct ExternalOllamaModel {
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    /// Lowercase 64-character model digest reported by Ollama's /api/tags API.
    pub digest: String,
    /// Installed Ollama model name including its tag.
    pub name: String,
}
impl OllamaProxy {
    pub(crate) fn validate(
        &self,
        provider: &InferenceProvider,
        model: &str,
        harness: &str,
    ) -> Result<(), ConfigError> {
        validate_endpoint(&self.endpoint, false)?;
        let upstream = url::Url::parse(&self.upstream.endpoint)
            .map_err(|_| ConfigError::new("invalid Ollama upstream"))?;
        let endpoint = url::Url::parse(&self.endpoint)
            .map_err(|_| ConfigError::new("invalid proxy endpoint"))?;
        let loopback = match upstream.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if provider.provider != "openai"
            || provider.credential.is_some()
            || !provider.endpoint.is_empty()
            || provider.service_ref.is_none()
            || provider
                .api
                .is_some_and(|api| api != InferenceApi::OpenaiCompletions)
            || !matches!(harness, "openclaw" | "hermes" | "deepagents" | "pi")
            || !loopback
            || upstream.scheme() != "http"
            || upstream.path() != "/v1"
            || upstream.port().is_none()
            || !matches!(endpoint.host(), Some(url::Host::Ipv4(_)))
            || endpoint.scheme() != "http"
            || endpoint.path() != "/v1"
            || endpoint.port().is_none()
            || self.endpoint == self.upstream.endpoint
            || !regex::Regex::new(constraints::IMAGE)
                .unwrap()
                .is_match(&self.image)
            || !regex::Regex::new("^[a-f0-9]{64}$")
                .unwrap()
                .is_match(&self.upstream.model.digest)
            || !regex::Regex::new(super::MODEL_PATTERN)
                .unwrap()
                .is_match(&self.upstream.model.name)
            || self.upstream.model.name != model
        {
            return Err(ConfigError::new(
                "Ollama proxy requires a local external daemon, pinned installed model, private endpoint, and OpenClaw, Hermes, Deep Agents, or Pi completions",
            ));
        }
        Ok(())
    }
}
