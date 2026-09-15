// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Serving-engine launch behavior; model and hardware qualification belongs to recipes.
use crate::{Error, config::Service};
pub(crate) mod validation;
pub(crate) mod vllm;
#[derive(Clone, Copy, Debug)]
pub enum Backend {
    Vllm,
}
impl Backend {
    pub fn arguments(
        self,
        service: &Service,
        model_directory: &str,
        total: u64,
    ) -> Result<Vec<String>, Error> {
        vllm::arguments(service, model_directory, total)
    }
}
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
        crate::hardware::Profile::SparkV1.check_capacity(
            self,
            capacity,
            starting,
            download_remaining,
            preparation_remaining,
        )
    }
    pub fn arguments(&self, model_directory: &str, total: u64) -> Result<Vec<String>, Error> {
        self.validate()?;
        Backend::Vllm.arguments(self, model_directory, total)
    }
}

#[cfg(test)]
mod tests;
