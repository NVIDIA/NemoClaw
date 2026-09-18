// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{ConfigError, HardwareProfile, Service};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
/// Explicit execution hardware: a named profile or dedicated GPU requirements. Excludes an inline recipe.
pub enum ServiceHardware {
    /// One NVIDIA GPU with dedicated memory on Linux AMD64.
    Dedicated(DedicatedHardware),
    /// A named hardware contract with fixed compatibility requirements.
    #[serde(rename_all = "camelCase")]
    Profile {
        /// GPU family. dgx-spark uses unified memory; all other profiles require observable dedicated GPU memory. Driver major 580 or newer is required.
        profile: HardwareProfile,
        /// Host CPU architecture: amd64 or arm64. Required for GPU profiles; system profiles fix arm64 and reject a conflicting value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(default, with = "String")]
        architecture: Option<String>,
        /// Minimum dedicated GPU memory in bytes, from 4 GiB through 4 TiB. Required with gpuMemoryUtilization; forbidden for dgx-spark. Fixed budgets otherwise use observed capacity.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(default, with = "u64")]
        min_gpu_memory_bytes: Option<u64>,
    },
}

impl ServiceHardware {
    pub fn architecture(&self) -> Result<&str, ConfigError> {
        match self {
            Self::Dedicated(hardware) => Ok(&hardware.architecture),
            Self::Profile {
                profile,
                architecture,
                ..
            } => match (profile.architecture(), architecture.as_deref()) {
                (Some(required), None) => Ok(required),
                (Some(required), Some(actual)) if required == actual => Ok(required),
                (None, Some(actual @ ("amd64" | "arm64"))) => Ok(actual),
                _ => Err(ConfigError::new(
                    "hardware profile requires a compatible explicit host architecture",
                )),
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Requirements for one NVIDIA GPU with dedicated memory on Linux AMD64. Declaring requirements does not qualify a model or host.
pub struct DedicatedHardware {
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
    pub(crate) fn dedicated_hardware(&self) -> Option<DedicatedHardware> {
        match &self.hardware {
            Some(ServiceHardware::Dedicated(hardware)) => Some(hardware.clone()),
            Some(
                hardware @ ServiceHardware::Profile {
                    profile,
                    min_gpu_memory_bytes,
                    ..
                },
            ) if *profile != HardwareProfile::DgxSpark => Some(DedicatedHardware {
                architecture: hardware.architecture().ok()?.into(),
                min_compute_capability: profile.compute_capability(),
                min_gpu_memory_bytes: min_gpu_memory_bytes.unwrap_or(4 * (1 << 30)),
                min_driver_major: 580,
            }),
            _ => None,
        }
    }

    pub(crate) fn architecture(&self) -> Result<&str, ConfigError> {
        match (&self.hardware, &self.recipe) {
            (Some(hardware), None) => hardware.architecture(),
            (None, Some(recipe)) => Ok(&recipe.compatibility.architecture),
            _ => Err(ConfigError::new(
                "declare exactly one of service.hardware or service.recipe",
            )),
        }
    }

    pub(crate) fn validate_hardware(&self) -> Result<(), ConfigError> {
        self.architecture()?;
        if let Some(ServiceHardware::Profile {
            profile,
            min_gpu_memory_bytes,
            ..
        }) = &self.hardware
        {
            if min_gpu_memory_bytes.is_some_and(|bytes| {
                *profile == HardwareProfile::DgxSpark
                    || !(4 * (1 << 30)..=4 * (1 << 40)).contains(&bytes)
            }) {
                return Err(ConfigError::new(
                    "profile minimum GPU memory must be 4 GiB through 4 TiB and excludes dgx-spark",
                ));
            }
            if self.memory.gpu_memory_utilization.is_some() && min_gpu_memory_bytes.is_none() {
                return Err(ConfigError::new(
                    "profile GPU utilization requires explicit minGpuMemoryBytes",
                ));
            }
        }
        if let Some(ServiceHardware::Dedicated(h)) = &self.hardware
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
            && (self.dedicated_hardware().is_none()
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
