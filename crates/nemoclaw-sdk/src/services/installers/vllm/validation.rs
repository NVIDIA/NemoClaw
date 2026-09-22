// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Service, constraints as c};
use crate::{Error, config::ConfigError, hardware::GIB, snapshot::Manifest};
pub(crate) fn gpu_bytes(service: &Service) -> u64 {
    if let Some(recipe) = &service.recipe {
        return recipe.resources.gpu_memory_bytes;
    }
    if let (Some(hardware), Some(ratio)) = (
        service.dedicated_hardware(),
        &service.memory.gpu_memory_utilization,
    ) {
        return (hardware.min_gpu_memory_bytes as f64 * ratio.as_f64().unwrap_or(0.0)).floor()
            as u64;
    }
    (if service.memory.gpu_memory_gib == 0 {
        c::GPU_MEMORY_DEFAULT
    } else {
        service.memory.gpu_memory_gib
    }) as u64
        * GIB
}
pub fn validate(service: &Service) -> Result<(), ConfigError> {
    if let Some(recipe) = &service.recipe {
        recipe.validate(service)?;
    }
    super::policy::validate_memory(&service.memory)?;
    if service.recipe.is_some() {
        return Ok(());
    }
    if gpu_bytes(service) < (service.memory.kv_cache_gib as u64 + 4) * GIB {
        return Err(ConfigError::new(
            "GPU memory budget must include KV cache and at least 4 GiB for model and runtime",
        ));
    }
    Ok(())
}
pub(crate) fn validate_weights(service: &Service, manifest: &Manifest) -> Result<(), Error> {
    if service.recipe.is_some() {
        return Ok(());
    }
    let weights: u64 = manifest
        .files
        .iter()
        .filter(|f| f.name.ends_with(".safetensors"))
        .map(|f| f.size)
        .sum();
    if weights == 0
        || weights
            .checked_add((service.memory.kv_cache_gib as u64 + 2) * GIB)
            .is_none_or(|bytes| bytes > gpu_bytes(service))
    {
        return Err(Error::Conflict(
            "model weights exceed the declared GPU memory budget",
        ));
    }
    Ok(())
}
