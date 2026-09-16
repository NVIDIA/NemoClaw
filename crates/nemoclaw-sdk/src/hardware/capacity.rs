// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Host-reserve policy informed by MiaAI Lab's single-Spark start.sh (AGPL-3.0-or-later).
// Source revision and attribution: crates/nemoclaw-sdk/NOTICE.md.
use super::{Capacity, GIB};
use crate::{Error, config::Service};
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
    if starting && c.foreign_gpu_processes != 0 {
        return Err(Error::Conflict(
            "GPU is in use by an unrelated process; service was not started",
        ));
    }
    check_memory(service, c, starting)
}

/// Verify the declared host/GPU contract and memory headroom independently of storage.
/// Dedicated GPU budgets use observed VRAM; the host watchdog remains active.
pub fn check_memory(service: &Service, c: &Capacity, starting: bool) -> Result<(), Error> {
    service.validate()?;
    check_compatibility(service, c)?;
    if service.hardware.is_some() {
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
        if budget > gpu.total || (starting && budget > gpu.free) {
            return Err(Error::Conflict(
                "insufficient dedicated GPU memory for the declared serving budget",
            ));
        }
        let reserve = service.memory.host_reserve_gib as u64 * GIB;
        if c.total < reserve || (starting && c.available < reserve + 20 * GIB) {
            return Err(Error::Conflict(
                "insufficient host memory reserve and startup headroom",
            ));
        }
    } else {
        if service.gpu_bytes()? + service.memory.host_reserve_gib as u64 * GIB > c.total {
            return Err(Error::Conflict(
                "requested GPU budget leaves less than declared host memory reserve",
            ));
        }
        if starting
            && c.available
                < service.gpu_bytes()?
                    + service
                        .recipe
                        .as_ref()
                        .map_or(20, |r| r.resources.startup_headroom_gi_b)
                        * GIB
        {
            return Err(Error::Conflict(
                "insufficient startup memory headroom; service was not started",
            ));
        }
    }
    Ok(())
}

/// Total memory used to translate the serving budget into vLLM's utilization setting.
pub fn serving_memory(service: &Service, capacity: &Capacity) -> Result<u64, Error> {
    if service.hardware.is_some() {
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
    if let Some(required) = &service.hardware {
        let gpu = c
            .gpu_memory
            .as_ref()
            .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
        if c.architecture != required.architecture
            || c.driver_major < required.min_driver_major
            || gpu.total < required.min_gpu_memory_bytes
            || gpu.free > gpu.total
            || gpu.compute_capability < required.min_compute_capability
        {
            return Err(Error::Conflict(
                "execution host does not satisfy dedicated GPU requirements",
            ));
        }
        Ok(())
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
        super::spark::check_compatibility(c)
    }
}
