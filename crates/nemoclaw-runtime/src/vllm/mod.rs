// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod config;
pub use config::{Memory, Model, Service, ServiceAuthentication, Serving};
pub mod constraints;
pub mod hardware_profile;
pub use hardware_profile::{HardwareProfile, MemoryArchitecture};
mod service_hardware;
pub use service_hardware::{DedicatedHardware, ServiceHardware, VllmLaunchMode};
pub mod arguments;
pub mod hardware_capacity;
mod hardware_policy;
pub mod policy;
pub mod recipes;
#[cfg(all(feature = "execution", target_os = "linux"))]
pub mod runtime;
pub mod schema;
pub mod validation;
impl Service {
    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        self.architecture()?;
        crate::schema::validate(&crate::RuntimeSpec::Vllm(Box::new(self.clone())))?;
        validation::validate(self)
    }
    pub fn gpu_bytes(&self) -> Result<u64, crate::Error> {
        self.validate()?;
        Ok(validation::gpu_bytes(self))
    }
    pub fn arguments(&self, directory: &str, total: u64) -> Result<Vec<String>, crate::Error> {
        self.validate()?;
        arguments::arguments(self, directory, total)
    }
    pub fn check_capacity(
        &self,
        capacity: &crate::hardware::Capacity,
        starting: bool,
        download: u64,
        preparation: u64,
    ) -> Result<(), crate::Error> {
        hardware_capacity::check_capacity(self, capacity, starting, download, preparation)
    }
}
