// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{super::vllm::MemoryArchitecture, ManagedOllama};
use crate::{
    Error,
    hardware::{Capacity, GIB, at_least},
};

pub fn check_memory(
    service: &ManagedOllama,
    capacity: &Capacity,
    starting: bool,
) -> Result<(), Error> {
    service.validate()?;
    check_compatibility(service, capacity)?;
    let reserve = service.memory.host_reserve_gib as u64 * GIB;
    if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        let gpu = capacity
            .gpu_memory
            .as_ref()
            .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
        let budget = budget(service, capacity)?;
        at_least("GPU total memory (bytes)", budget, gpu.total)?;
        if starting {
            at_least("GPU free memory (bytes)", budget, gpu.free)?;
        }
        at_least("host total memory (bytes)", reserve, capacity.total)?;
        if starting {
            at_least(
                "host available memory (bytes)",
                reserve + 20 * GIB,
                capacity.available,
            )?;
        }
    } else {
        let budget = service.gpu_bytes()?;
        at_least(
            "host total memory (bytes)",
            budget + reserve,
            capacity.total,
        )?;
        if starting {
            at_least(
                "host available memory (bytes)",
                budget + 20 * GIB,
                capacity.available,
            )?;
        }
    }
    Ok(())
}

pub fn serving_memory(service: &ManagedOllama, capacity: &Capacity) -> Result<u64, Error> {
    if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        capacity
            .gpu_memory
            .as_ref()
            .map(|gpu| gpu.total)
            .ok_or(Error::State("dedicated GPU memory is unobservable"))
    } else {
        Ok(capacity.total)
    }
}

pub fn budget(service: &ManagedOllama, capacity: &Capacity) -> Result<u64, Error> {
    let total = serving_memory(service, capacity)?;
    let budget = service
        .memory
        .gpu_memory_utilization
        .as_ref()
        .and_then(serde_json::Number::as_f64)
        .map_or(service.gpu_bytes()?, |ratio| {
            (total as f64 * ratio).floor() as u64
        });
    if budget == 0 || budget > total {
        return Err(Error::Conflict("invalid Ollama serving memory budget"));
    }
    Ok(budget)
}

fn check_compatibility(service: &ManagedOllama, capacity: &Capacity) -> Result<(), Error> {
    if !(10..=999).contains(&capacity.compute_capability) {
        return Err(Error::State("GPU compute capability is unobservable"));
    }
    if let Some(hardware) = &service.hardware {
        hardware.check_compatibility(capacity)?;
    }
    Ok(())
}
