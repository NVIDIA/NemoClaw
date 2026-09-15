// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
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
    Ok(())
}

fn check_compatibility(service: &Service, c: &Capacity) -> Result<(), Error> {
    if let Some(recipe) = &service.recipe {
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
