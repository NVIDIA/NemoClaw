// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Capacity, GIB};
use crate::Error;

pub(super) fn check_compatibility(c: &Capacity) -> Result<(), Error> {
    if c.architecture != "arm64"
        || c.gpu != "NVIDIA GB10"
        || c.driver_major < 580
        || c.total < 118 * GIB
    {
        return Err(Error::Conflict(
            "backend requires ARM64 GB10 Spark with at least 118 GiB RAM and NVIDIA driver 580 or newer",
        ));
    }
    Ok(())
}

pub(crate) fn validate_memory(
    memory: &crate::config::Memory,
) -> Result<(), crate::config::ConfigError> {
    fn require(condition: bool, message: &'static str) -> Result<(), crate::config::ConfigError> {
        if condition {
            Ok(())
        } else {
            Err(crate::config::ConfigError(message))
        }
    }
    require(
        (28..=64).contains(&memory.host_reserve_gib)
            && (4..=12).contains(&memory.kv_cache_gib)
            && (6..=16).contains(&memory.min_available_gib)
            && (2..=8).contains(&memory.min_free_gib)
            && (memory.min_available_gib..=24).contains(&memory.free_gate_gib)
            && (1..=5).contains(&memory.consecutive_samples),
        "memory policy exceeds qualified Spark bounds",
    )
}
