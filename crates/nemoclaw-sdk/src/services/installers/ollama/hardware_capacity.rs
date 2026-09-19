// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    super::vllm::{MemoryArchitecture, ServiceHardware},
    ManagedOllama,
};
use crate::{
    Error,
    hardware::{Capacity, GIB},
};

pub(crate) fn check_capacity(
    service: &ManagedOllama,
    capacity: &Capacity,
    starting: bool,
    download_remaining: u64,
) -> Result<(), Error> {
    let disk = download_remaining
        .checked_add(16 * GIB)
        .ok_or(Error::State("invalid remaining Ollama storage capacity"))?;
    if capacity.disk_free < disk {
        return Err(Error::Conflict(
            "insufficient disk for the pinned Ollama model and 16 GiB working reserve",
        ));
    }
    check_memory(service, capacity, starting)
}

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
        if budget > gpu.total || (starting && budget > gpu.free) {
            return Err(Error::Conflict(
                "insufficient dedicated GPU memory for the Ollama serving budget",
            ));
        }
        if capacity.total < reserve || (starting && capacity.available < reserve + 20 * GIB) {
            return Err(Error::Conflict(
                "insufficient host memory reserve and Ollama startup headroom",
            ));
        }
    } else {
        let budget = service.gpu_bytes()?;
        if budget + reserve > capacity.total {
            return Err(Error::Conflict(
                "Ollama GPU budget leaves less than the declared host memory reserve",
            ));
        }
        if starting && capacity.available < budget + 20 * GIB {
            return Err(Error::Conflict(
                "insufficient Ollama startup memory headroom; service was not started",
            ));
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
    if let Some(ServiceHardware::Profile { profile, .. }) = &service.hardware
        && (!profile.matches_gpu(&capacity.gpu)
            || capacity.compute_capability < profile.compute_capability()
            || capacity.architecture != service.architecture()?
            || capacity.driver_major < 580
            || capacity.total < profile.min_host_memory_bytes())
    {
        return Err(Error::Conflict(
            "execution host does not satisfy the declared Ollama hardware profile",
        ));
    }
    if let Some(required) = service.dedicated_hardware() {
        let gpu = capacity
            .gpu_memory
            .as_ref()
            .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
        if capacity.architecture != required.architecture
            || capacity.driver_major < required.min_driver_major
            || capacity.compute_capability < required.min_compute_capability
            || gpu.total < required.min_gpu_memory_bytes
            || gpu.free > gpu.total
        {
            return Err(Error::Conflict(
                "execution host does not satisfy dedicated Ollama GPU requirements",
            ));
        }
    }
    Ok(())
}
