// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{HardwareProfile, MemoryArchitecture, Service};
use crate::config::ConfigError;
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
        /// GPU family and memory architecture. Every profile requires observed compute capability and driver major 580 or newer. Unified-memory profiles budget host RAM; dedicated-memory profiles require GPU total/free counters.
        profile: HardwareProfile,
        /// Host CPU architecture: amd64 or arm64. Required for GPU profiles; system profiles fix arm64 and reject a conflicting value.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(default, with = "String")]
        architecture: Option<String>,
        /// Minimum dedicated GPU memory in bytes, from 4 GiB through 4 TiB. Required with gpuMemoryUtilization; forbidden for unified-memory profiles. Fixed budgets otherwise use observed capacity.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[schemars(default, with = "u64")]
        min_gpu_memory_bytes: Option<u64>,
    },
}

impl ServiceHardware {
    pub(crate) fn check_compatibility(
        &self,
        capacity: &crate::hardware::Capacity,
    ) -> Result<(), crate::Error> {
        use crate::hardware::{GIB, HardwareDiagnostic, architecture, at_least};
        architecture(self.architecture()?, &capacity.architecture)?;
        let (compute, driver, memory) = match self {
            Self::Dedicated(required) => (
                required.min_compute_capability,
                required.min_driver_major,
                Some(required.min_gpu_memory_bytes),
            ),
            Self::Profile {
                profile,
                min_gpu_memory_bytes,
                ..
            } => {
                if !profile.matches_gpu(&capacity.gpu) {
                    return Err(
                        crate::ObservationError::Hardware(HardwareDiagnostic::Mismatch {
                            field: "hardware.profile",
                            required: profile.gpu_family(),
                            observed: "different GPU family",
                        })
                        .into(),
                    );
                }
                at_least(
                    "host total memory (bytes)",
                    profile.min_host_memory_bytes(),
                    capacity.total,
                )?;
                (
                    profile.compute_capability(),
                    580,
                    (profile.memory_architecture() == MemoryArchitecture::Dedicated)
                        .then_some(min_gpu_memory_bytes.unwrap_or(4 * GIB)),
                )
            }
        };
        at_least(
            "hardware.minComputeCapability",
            compute.into(),
            capacity.compute_capability.into(),
        )?;
        at_least(
            "hardware.minDriverMajor",
            driver.into(),
            capacity.driver_major.into(),
        )?;
        if let Some(required) = memory {
            let gpu = capacity
                .gpu_memory
                .as_ref()
                .ok_or(crate::Error::State("dedicated GPU memory is unobservable"))?;
            if gpu.free > gpu.total {
                return Err(crate::Error::State("GPU free memory exceeds total memory"));
            }
            at_least("hardware.minGpuMemoryBytes", required, gpu.total)?;
        }
        Ok(())
    }

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
    /// Select the launch contract without changing its authored representation.
    pub fn launch_mode(&self) -> Result<VllmLaunchMode<'_>, ConfigError> {
        match (&self.hardware, self.recipe.as_deref()) {
            (Some(hardware), None) => Ok(VllmLaunchMode::Native { hardware }),
            (None, Some(recipe)) => Ok(VllmLaunchMode::Recipe { recipe }),
            _ => Err(ConfigError::new(
                "declare exactly one of service.hardware or service.recipe",
            )),
        }
    }
    pub(crate) fn memory_architecture(&self) -> Result<MemoryArchitecture, ConfigError> {
        Ok(match self.launch_mode()? {
            VllmLaunchMode::Native {
                hardware: ServiceHardware::Dedicated(_),
            } => MemoryArchitecture::Dedicated,
            VllmLaunchMode::Native {
                hardware: ServiceHardware::Profile { profile, .. },
            } => profile.memory_architecture(),
            // The inline-recipe resource contract budgets host memory.
            VllmLaunchMode::Recipe { .. } => MemoryArchitecture::Unified,
        })
    }

    pub(crate) fn dedicated_hardware(&self) -> Option<DedicatedHardware> {
        match &self.hardware {
            Some(ServiceHardware::Dedicated(hardware)) => Some(hardware.clone()),
            Some(
                hardware @ ServiceHardware::Profile {
                    profile,
                    min_gpu_memory_bytes,
                    ..
                },
            ) if profile.memory_architecture() == MemoryArchitecture::Dedicated => {
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

    pub(crate) fn architecture(&self) -> Result<&str, ConfigError> {
        match self.launch_mode()? {
            VllmLaunchMode::Native { hardware } => hardware.architecture(),
            VllmLaunchMode::Recipe { recipe } => Ok(&recipe.compatibility.architecture),
        }
    }
}

/// Mutually exclusive contracts for native serving and recipe preparation/serving.
#[derive(Clone, Copy, Debug)]
pub enum VllmLaunchMode<'a> {
    Native {
        hardware: &'a ServiceHardware,
    },
    Recipe {
        recipe: &'a super::recipes::inline::InlineRecipe,
    },
}
