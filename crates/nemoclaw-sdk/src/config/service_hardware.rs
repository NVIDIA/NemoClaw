// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, Service};
use serde::{Deserialize, Serialize};

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
    pub(crate) fn validate_hardware(&self) -> Result<(), ConfigError> {
        if let Some(h) = &self.hardware
            && (h.architecture != "amd64"
                || !(10..=999).contains(&h.min_compute_capability)
                || !(4 * (1 << 30)..=4 * (1 << 40)).contains(&h.min_gpu_memory_bytes)
                || !(1..=9999).contains(&h.min_driver_major)
                || self.recipe.is_some())
        {
            return Err(ConfigError(
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
            return Err(ConfigError(
                "GPU utilization requires dedicated hardware and excludes fixed GPU and KV-cache budgets",
            ));
        }
        if self
            .container
            .as_ref()
            .is_some_and(|c| !(1..=64).contains(&c.shared_memory_gi_b))
        {
            return Err(ConfigError("shared memory must be between 1 and 64 GiB"));
        }
        Ok(())
    }
}
