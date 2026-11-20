// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Capacity, GIB, ProtectionPolicy, at_least};
use crate::{
    Error,
    vllm::{MemoryArchitecture, ServiceHardware},
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    default = "SingleGpuMemory::<DEFAULT_GPU_GIB>::default",
    rename_all = "camelCase",
    deny_unknown_fields
)]
#[schemars(rename = "SingleGpuMemory{DEFAULT_GPU_GIB}")]
/// Single-GPU admission budget and continuous host memory thresholds.
pub struct SingleGpuMemory<const DEFAULT_GPU_GIB: u64> {
    #[serde(rename = "gpuMemoryGiB")]
    #[schemars(range(min = 4, max = 512))]
    /// GPU budget in GiB; native allocation semantics depend on the backend.
    pub gpu_memory_gib: u64,
    #[serde(rename = "hostReserveGiB")]
    #[schemars(range(min = 28, max = 64))]
    /// Host memory reserved outside the native model allocation, in GiB.
    pub host_reserve_gib: u64,
    #[serde(rename = "minAvailableGiB")]
    #[schemars(range(min = 6, max = 16))]
    /// Stop threshold for available host memory, in GiB.
    pub min_available_gib: u64,
    #[serde(rename = "minFreeGiB")]
    #[schemars(range(min = 2, max = 8))]
    /// Stop threshold for free host memory, in GiB.
    pub min_free_gib: u64,
    #[serde(rename = "freeGateGiB")]
    #[schemars(range(min = 6, max = 24))]
    /// Available-memory gate for the free-memory threshold, in GiB.
    pub free_gate_gib: u64,
    #[schemars(range(min = 1, max = 5))]
    /// Consecutive low-memory observations required to stop native inference.
    pub consecutive_samples: u64,
}
impl<const DEFAULT_GPU_GIB: u64> Default for SingleGpuMemory<DEFAULT_GPU_GIB> {
    fn default() -> Self {
        Self {
            gpu_memory_gib: DEFAULT_GPU_GIB,
            host_reserve_gib: 32,
            min_available_gib: 8,
            min_free_gib: 3,
            free_gate_gib: 12,
            consecutive_samples: 5,
        }
    }
}

impl<const DEFAULT_GPU_GIB: u64> SingleGpuMemory<DEFAULT_GPU_GIB> {
    pub fn check(
        &self,
        hardware: &ServiceHardware,
        architecture: MemoryArchitecture,
        capacity: &Capacity,
        starting: bool,
    ) -> Result<(), Error> {
        capacity.require_one_gpu()?;
        hardware.check_compatibility(capacity)?;
        let reserve = self.host_reserve_gib * GIB;
        match architecture {
            MemoryArchitecture::Dedicated => {
                let gpu = capacity.selected_gpus()?[0]
                    .memory
                    .as_ref()
                    .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
                at_least(
                    "GPU total memory (bytes)",
                    self.gpu_memory_gib * GIB,
                    gpu.total,
                )?;
                at_least("host total memory (bytes)", reserve, capacity.total)?;
                if starting {
                    at_least(
                        "GPU free memory (bytes)",
                        self.gpu_memory_gib * GIB,
                        gpu.free,
                    )?;
                    at_least(
                        "host available memory (bytes)",
                        reserve + 20 * GIB,
                        capacity.available,
                    )?;
                }
            }
            MemoryArchitecture::Unified => {
                at_least(
                    "host total memory (bytes)",
                    self.gpu_memory_gib * GIB + reserve,
                    capacity.total,
                )?;
                if starting {
                    at_least(
                        "host available memory (bytes)",
                        self.gpu_memory_gib * GIB + 20 * GIB,
                        capacity.available,
                    )?;
                }
            }
        }
        Ok(())
    }
    pub fn protection(&self) -> Result<ProtectionPolicy, Error> {
        ProtectionPolicy::new(
            self.min_available_gib * GIB,
            self.min_free_gib * GIB,
            self.free_gate_gib * GIB,
            self.consecutive_samples,
        )
    }
}
