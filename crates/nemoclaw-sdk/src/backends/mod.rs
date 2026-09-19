// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Serving-engine launch behavior; model and hardware qualification belongs to recipes.
use crate::{Error, config::Service};
pub mod ollama;
pub(crate) mod validation;
pub(crate) mod vllm;
impl Service {
    pub fn gpu_bytes(&self) -> Result<u64, Error> {
        self.validate()?;
        Ok(validation::gpu_bytes(self))
    }
    pub fn check_capacity(
        &self,
        capacity: &crate::hardware::Capacity,
        starting: bool,
        download_remaining: u64,
        preparation_remaining: u64,
    ) -> Result<(), Error> {
        crate::hardware::check_capacity(
            self,
            capacity,
            starting,
            download_remaining,
            preparation_remaining,
        )
    }
    pub fn arguments(&self, model_directory: &str, total: u64) -> Result<Vec<String>, Error> {
        self.validate()?;
        if self.backend != "vllm" {
            return Err(Error::Conflict("this backend does not use vLLM arguments"));
        }
        vllm::arguments(self, model_directory, total)
    }
}

#[cfg(test)]
mod tests;
