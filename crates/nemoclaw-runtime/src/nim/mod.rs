// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Native NIM startup with a pinned vLLM-backed profile.
mod config;
#[cfg(all(feature = "execution", target_os = "linux"))]
mod output;
#[cfg(all(feature = "execution", target_os = "linux"))]
mod process;
#[cfg(any(test, all(feature = "execution", target_os = "linux")))]
mod readiness;
#[cfg(all(feature = "execution", target_os = "linux"))]
pub mod runtime;
pub use config::{NimBackend, NimMemory, NimModel, NimService, NimServing};

use crate::{
    Error,
    config::ConfigError,
    hardware::{Capacity, GIB, at_least},
    vllm::{MemoryArchitecture, ServiceHardware},
};

impl NimService {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::schema::validate(&crate::RuntimeSpec::Nim(Box::new(self.clone())))?;
        self.hardware.architecture()?;
        crate::require(
            self.model.min_gpu_memory_bytes <= self.gpu_bytes(),
            "NIM profile minimum exceeds the GPU budget",
        )?;
        crate::require(
            self.memory.free_gate_gib >= self.memory.min_available_gib,
            "memory free gate must be at least the available-memory threshold",
        )
    }
    pub fn architecture(&self) -> Result<&str, ConfigError> {
        self.hardware.architecture()
    }
    pub fn served_model(&self) -> &str {
        &self.model.name
    }
    pub fn gpu_bytes(&self) -> u64 {
        self.memory.gpu_memory_gib * GIB
    }
    pub fn memory_architecture(&self) -> MemoryArchitecture {
        match &self.hardware {
            ServiceHardware::Dedicated(_) => MemoryArchitecture::Dedicated,
            ServiceHardware::Profile { profile, .. } => profile.memory_architecture(),
        }
    }
    pub fn check_memory(&self, capacity: &Capacity, starting: bool) -> Result<(), Error> {
        self.validate()?;
        self.memory.check(
            &self.hardware,
            self.memory_architecture(),
            capacity,
            starting,
        )
    }

    pub fn check_capacity(&self, capacity: &Capacity, starting: bool) -> Result<(), Error> {
        self.check_memory(capacity, starting)?;
        // Native NIM owns its cache completeness; do not infer a completed
        // download from a directory or skip admission on a partial cache.
        at_least(
            "NIM cache and working disk reserve (bytes)",
            self.model.cache_bytes + 16 * GIB,
            capacity.disk_free,
        )
    }
}
