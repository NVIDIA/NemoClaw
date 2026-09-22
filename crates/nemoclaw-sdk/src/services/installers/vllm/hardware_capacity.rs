// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Host-reserve policy informed by MiaAI Lab's single-Spark start.sh (AGPL-3.0-or-later).
// Source revision and attribution: crates/nemoclaw-sdk/NOTICE.md.
use crate::hardware::{Capacity, GIB, at_least};
use crate::{
    Error,
    services::installers::vllm::{MemoryArchitecture, Service},
};
pub fn check_capacity(
    service: &Service,
    c: &Capacity,
    starting: bool,
    download_remaining: u64,
    preparation_remaining: u64,
) -> Result<(), Error> {
    service.validate()?;
    check_compatibility(service, c)?;
    if starting
        && let Some(recipe) = &service.recipe
        && c.available
            < recipe.resources.preparation_memory_gi_b * GIB
                + service.memory.host_reserve_gib as u64 * GIB
    {
        return Err(Error::Conflict(
            "insufficient recipe preparation memory headroom",
        ));
    }
    let disk = download_remaining
        .checked_add(preparation_remaining)
        .and_then(|n| n.checked_add(16 * GIB))
        .ok_or(Error::State("invalid remaining storage capacity"))?;
    if c.disk_free < disk {
        return Err(Error::Conflict(
            "insufficient disk for remaining pinned model, prepared data, and 16 GiB working reserve",
        ));
    }
    check_memory(service, c, starting)
}

/// Verify the declared host/GPU contract and memory headroom independently of storage.
/// Dedicated GPU budgets use observed VRAM; the host watchdog remains active.
pub fn check_memory(service: &Service, c: &Capacity, starting: bool) -> Result<(), Error> {
    service.validate()?;
    check_compatibility(service, c)?;
    if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        let gpu = c
            .gpu_memory
            .as_ref()
            .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
        let budget = service
            .memory
            .gpu_memory_utilization
            .as_ref()
            .and_then(serde_json::Number::as_f64)
            .map_or(service.gpu_bytes()?, |r| {
                (gpu.total as f64 * r).floor() as u64
            });
        at_least("GPU total memory (bytes)", budget, gpu.total)?;
        if starting {
            at_least("GPU free memory (bytes)", budget, gpu.free)?;
        }
        let reserve = service.memory.host_reserve_gib as u64 * GIB;
        at_least("host total memory (bytes)", reserve, c.total)?;
        if starting {
            at_least(
                "host available memory (bytes)",
                reserve + 20 * GIB,
                c.available,
            )?;
        }
    } else {
        at_least(
            "host total memory (bytes)",
            service.gpu_bytes()? + service.memory.host_reserve_gib as u64 * GIB,
            c.total,
        )?;
        if starting {
            at_least(
                "host available memory (bytes)",
                service.gpu_bytes()?
                    + service
                        .recipe
                        .as_ref()
                        .map_or(20, |r| r.resources.startup_headroom_gi_b)
                        * GIB,
                c.available,
            )?;
        }
    }
    Ok(())
}

/// Total memory used to translate the serving budget into vLLM's utilization setting.
pub fn serving_memory(service: &Service, capacity: &Capacity) -> Result<u64, Error> {
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

fn check_compatibility(service: &Service, c: &Capacity) -> Result<(), Error> {
    if !(10..=999).contains(&c.compute_capability) {
        return Err(Error::State("GPU compute capability is unobservable"));
    }
    if let Some(hardware) = &service.hardware {
        hardware.check_compatibility(c)
    } else if let Some(recipe) = &service.recipe {
        let required = &recipe.compatibility;
        if c.architecture != required.architecture
            || c.gpu != required.gpu
            || (c.driver_major as u64) < required.min_driver_major
            || c.total < required.min_host_memory_gi_b * GIB
        {
            return Err(Error::Conflict(
                "execution host does not satisfy recipe compatibility requirements",
            ));
        }
        Ok(())
    } else {
        Err(crate::config::ConfigError::new(
            "declare exactly one of service.hardware or service.recipe",
        )
        .into())
    }
}
