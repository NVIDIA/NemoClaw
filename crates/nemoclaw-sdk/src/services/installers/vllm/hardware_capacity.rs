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

/// Account for all selected services on one engine before starting any of them.
/// Running services already consume the observed free memory; only stopped or
/// new services add startup demand. GPU budgets remain reserved across restarts.
pub fn check_service_budgets(services: &[(&Service, bool)], c: &Capacity) -> Result<(), Error> {
    let mut total_budget = 0u64;
    let mut new_budget = 0u64;
    let mut reserve = 0u64;
    let mut startup = 0u64;
    let architecture = services
        .first()
        .map(|(s, _)| s.memory_architecture())
        .transpose()?;
    for &(service, starting) in services {
        check_memory(service, c, starting)?;
        if Some(service.memory_architecture()?) != architecture {
            return Err(Error::Conflict(
                "services sharing an engine must use the same GPU memory contract",
            ));
        }
        let budget = service
            .memory
            .gpu_memory_utilization
            .as_ref()
            .and_then(serde_json::Number::as_f64)
            .map_or(service.gpu_bytes()?, |ratio| {
                (c.gpu_memory.as_ref().map_or(0, |g| g.total) as f64 * ratio).floor() as u64
            });
        total_budget = total_budget
            .checked_add(budget)
            .ok_or(Error::State("combined GPU budget overflow"))?;
        reserve = reserve.max(service.memory.host_reserve_gib as u64 * GIB);
        if starting {
            new_budget = new_budget
                .checked_add(budget)
                .ok_or(Error::State("combined GPU budget overflow"))?;
            let headroom = service.recipe.as_ref().map_or(20, |r| {
                r.resources
                    .startup_headroom_gi_b
                    .max(r.resources.preparation_memory_gi_b)
            });
            startup = startup
                .checked_add(headroom * GIB)
                .ok_or(Error::State("combined startup budget overflow"))?;
        }
    }
    let fits = if architecture == Some(MemoryArchitecture::Dedicated) {
        c.gpu_memory
            .as_ref()
            .is_some_and(|gpu| total_budget <= gpu.total && new_budget <= gpu.free)
            && (new_budget == 0 || reserve + startup <= c.available)
    } else {
        total_budget + reserve <= c.total && new_budget + startup <= c.available
    };
    if !fits {
        return Err(Error::Conflict(
            "combined inference budgets exceed available GPU or host startup memory",
        ));
    }
    Ok(())
}
