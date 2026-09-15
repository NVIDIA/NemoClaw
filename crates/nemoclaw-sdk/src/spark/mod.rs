// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Compatibility names for the original Spark SDK surface.
//! New consumers select a recipe and use its backend and hardware profile.
pub use crate::hardware::{Capacity, Watchdog, read_memory};
pub use crate::recipes::qwen38::*;
use crate::{Error, config::Service};
impl Service {
    pub fn gpu_bytes(&self) -> Result<u64, Error> {
        self.validate()?;
        if self.backend == crate::recipes::huggingface::BACKEND {
            return Ok(crate::recipes::huggingface::gpu_bytes(self));
        }
        crate::recipes::qwen38::gpu_bytes(self)
    }
    pub fn check_capacity(
        &self,
        capacity: &Capacity,
        starting: bool,
        download_remaining: u64,
        preparation_remaining: u64,
    ) -> Result<(), Error> {
        crate::recipes::resolve(self)?.hardware().check_capacity(
            self,
            capacity,
            starting,
            download_remaining,
            preparation_remaining,
        )
    }
    pub fn arguments(&self, model_directory: &str, total: u64) -> Result<Vec<String>, Error> {
        crate::recipes::resolve(self)?
            .backend()
            .arguments(self, model_directory, total)
    }
}
#[cfg(test)]
mod tests;
