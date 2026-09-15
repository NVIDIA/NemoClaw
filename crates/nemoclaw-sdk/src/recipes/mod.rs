// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Versioned model recipes select a qualified backend and hardware profile.
use crate::{Error, backends::Backend, config::Service, hardware::Profile, snapshot::Manifest};
pub mod huggingface;
pub mod inline;
pub mod preparation;
pub mod qwen38;
#[derive(Clone, Copy, Debug)]
pub enum Recipe {
    Qwen38V1,
    HuggingFace,
}
pub fn resolve(service: &Service) -> Result<Recipe, Error> {
    service.validate()?;
    match service.backend.as_str() {
        qwen38::BACKEND => Ok(Recipe::Qwen38V1),
        huggingface::BACKEND => Ok(Recipe::HuggingFace),
        _ => Err(Error::Conflict(
            "recipe has no qualified backend and hardware combination",
        )),
    }
}
impl Recipe {
    pub(crate) fn vllm_settings(
        self,
        service: &Service,
    ) -> Result<crate::backends::vllm::ModelSettings<'_>, Error> {
        match self {
            Self::Qwen38V1 => qwen38::vllm_settings(service),
            Self::HuggingFace => Err(Error::Conflict(
                "generic model uses backend settings directly",
            )),
        }
    }
    pub fn backend(self) -> Backend {
        match self {
            Self::Qwen38V1 | Self::HuggingFace => Backend::Vllm,
        }
    }
    pub fn hardware(self) -> Profile {
        match self {
            Self::Qwen38V1 | Self::HuggingFace => Profile::SparkV1,
        }
    }
    pub fn manifest(self) -> Result<Manifest, Error> {
        match self {
            Self::Qwen38V1 => Ok(qwen38::model_manifest()),
            Self::HuggingFace => Err(Error::Conflict(
                "generic manifest requires async resolution",
            )),
        }
    }
    pub fn preparation_key(self) -> String {
        match self {
            Self::Qwen38V1 => qwen38::preparation_key(),
            Self::HuggingFace => String::new(),
        }
    }
    pub fn prepared_bytes(self) -> u64 {
        match self {
            Self::Qwen38V1 => qwen38::PREPARED_BYTES,
            Self::HuggingFace => 0,
        }
    }
}

pub(crate) fn validate(service: &Service) -> Result<(), crate::config::ConfigError> {
    match service.backend.as_str() {
        qwen38::BACKEND => qwen38::validate(service),
        huggingface::BACKEND => huggingface::validate(service),
        _ => Err(crate::config::ConfigError(
            "Spark requires qualified backend, pinned model, and immutable image",
        )),
    }
}
