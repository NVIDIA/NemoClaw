// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Versioned model recipes select a qualified backend and hardware profile.
use crate::{Error, backends::Backend, config::Service, hardware::Profile, snapshot::Manifest};
pub mod qwen38;
#[derive(Clone, Copy, Debug)]
pub enum Recipe {
    Qwen38V1,
}
pub fn resolve(service: &Service) -> Result<Recipe, Error> {
    service.validate()?;
    match service.backend.as_str() {
        qwen38::BACKEND => Ok(Recipe::Qwen38V1),
        _ => Err(Error::Conflict(
            "recipe has no qualified backend and hardware combination",
        )),
    }
}
impl Recipe {
    pub(crate) fn vllm_settings(
        self,
        service: &Service,
    ) -> Result<crate::backends::vllm::ModelSettings, Error> {
        match self {
            Self::Qwen38V1 => qwen38::vllm_settings(service),
        }
    }
    pub fn backend(self) -> Backend {
        match self {
            Self::Qwen38V1 => Backend::Vllm,
        }
    }
    pub fn hardware(self) -> Profile {
        match self {
            Self::Qwen38V1 => Profile::SparkV1,
        }
    }
    pub fn manifest(self) -> Manifest {
        match self {
            Self::Qwen38V1 => qwen38::model_manifest(),
        }
    }
    pub fn preparation_key(self) -> String {
        match self {
            Self::Qwen38V1 => qwen38::preparation_key(),
        }
    }
    pub fn prepared_bytes(self) -> u64 {
        match self {
            Self::Qwen38V1 => qwen38::PREPARED_BYTES,
        }
    }
}

pub(crate) fn validate(service: &Service) -> Result<(), crate::config::ConfigError> {
    match service.backend.as_str() {
        qwen38::BACKEND => qwen38::validate(service),
        _ => Err(crate::config::ConfigError(
            "Spark requires qualified backend, pinned model, and immutable image",
        )),
    }
}
