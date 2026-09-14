// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Serving-engine launch behavior; model and hardware qualification belongs to recipes.
use crate::{Error, config::Service};
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
        match self {
            Self::Vllm => {
                let recipe = crate::recipes::resolve(service)?;
                vllm::arguments(
                    &service.serving,
                    model_directory,
                    total,
                    recipe.vllm_settings(service)?,
                )
            }
        }
    }
}
