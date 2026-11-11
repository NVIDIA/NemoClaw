// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Host-reserve policy informed by MiaAI Lab's single-Spark start.sh (AGPL-3.0-or-later).
// Source revision and attribution: crates/nemoclaw-runtime/NOTICE.md.
use crate::hardware::{Capacity, GIB, at_least, on_gpu};
use crate::{
    Error,
    vllm::{MemoryArchitecture, Service},
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
/// A dedicated GPU budget applies to each selected GPU, checked against its
/// observed VRAM; the host reserve applies once, and the host watchdog remains active.
pub fn check_memory(service: &Service, c: &Capacity, starting: bool) -> Result<(), Error> {
    service.validate()?;
    check_compatibility(service, c)?;
    let headroom = service
        .recipe
        .as_ref()
        .map_or(20, |r| r.resources.startup_headroom_gi_b)
        * GIB;
    if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        for gpu in c.selected_gpus()? {
            let memory = gpu
                .memory
                .as_ref()
                .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
            let budget = gpu_budget(service, memory.total)?;
            on_gpu(
                gpu,
                at_least("GPU total memory (bytes)", budget, memory.total),
            )?;
            if starting {
                on_gpu(
                    gpu,
                    at_least("GPU free memory (bytes)", budget, memory.free),
                )?;
            }
        }
        let reserve = service.memory.host_reserve_gib as u64 * GIB;
        at_least("host total memory (bytes)", reserve, c.total)?;
        if starting {
            at_least(
                "host available memory (bytes)",
                reserve + headroom,
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
                service.gpu_bytes()? + headroom,
                c.available,
            )?;
        }
    }
    Ok(())
}

/// The service's budget on a dedicated GPU with `total` bytes: a utilization
/// fraction of that GPU's own total, as vLLM applies it to each GPU, or the
/// fixed per-GPU budget.
pub fn gpu_budget(service: &Service, total: u64) -> Result<u64, Error> {
    Ok(service
        .memory
        .gpu_memory_utilization
        .as_ref()
        .and_then(serde_json::Number::as_f64)
        .map_or(service.gpu_bytes()?, |ratio| {
            (total as f64 * ratio).floor() as u64
        }))
}

/// Total memory used to translate a fixed serving budget into vLLM's
/// utilization fraction: the host's on unified memory, or the largest selected
/// GPU's. vLLM requires that fraction of each GPU's own total to be free when
/// it starts, so the largest total keeps the request within the budget on
/// every GPU. Without a recipe, vLLM sizes the KV cache from
/// --kv-cache-memory-bytes, so GPUs of different sizes get the same budget.
pub fn serving_memory(service: &Service, capacity: &Capacity) -> Result<u64, Error> {
    if service.memory_architecture()? == MemoryArchitecture::Dedicated {
        let mut largest = 0;
        for gpu in capacity.selected_gpus()? {
            let gpu = gpu
                .memory
                .as_ref()
                .ok_or(Error::State("dedicated GPU memory is unobservable"))?;
            largest = largest.max(gpu.total);
        }
        Ok(largest)
    } else {
        Ok(capacity.total)
    }
}

fn check_compatibility(service: &Service, c: &Capacity) -> Result<(), Error> {
    let gpus = c.selected_gpus()?;
    if gpus
        .iter()
        .any(|gpu| !(10..=999).contains(&gpu.compute_capability))
    {
        return Err(Error::State("GPU compute capability is unobservable"));
    }
    if let Some(hardware) = &service.hardware {
        hardware.check_compatibility(c)
    } else if let Some(recipe) = &service.recipe {
        let required = &recipe.compatibility;
        if c.architecture != required.architecture
            || c.total < required.min_host_memory_gi_b * GIB
            || gpus.iter().any(|gpu| {
                gpu.name != required.gpu || (gpu.driver_major as u64) < required.min_driver_major
            })
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
