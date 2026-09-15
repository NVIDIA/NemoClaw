// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Host observations and validated memory protection, independent of a recipe.
use crate::{Error, config::Service};
use std::{collections::BTreeMap, io::Read};
pub const GIB: u64 = 1 << 30;
#[derive(Clone, Debug, Default)]
pub struct Capacity {
    pub architecture: String,
    pub gpu: String,
    pub driver_major: u32,
    pub total: u64,
    pub available: u64,
    pub free: u64,
    pub disk_free: u64,
    pub foreign_gpu_processes: usize,
}
pub fn read_memory(reader: impl Read) -> Result<Capacity, Error> {
    let mut text = String::new();
    reader
        .take((1 << 20) + 1)
        .read_to_string(&mut text)
        .map_err(|_| Error::State("host memory observation failed"))?;
    if text.len() > 1 << 20 {
        return Err(Error::State("host memory observation exceeds limit"));
    }
    let mut values = BTreeMap::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields
            .first()
            .is_some_and(|key| ["MemTotal:", "MemAvailable:", "MemFree:"].contains(key))
        {
            if fields.len() != 3 || fields[2] != "kB" {
                return Err(Error::State("incomplete host memory observation"));
            }
            let number = fields[1]
                .parse::<u64>()
                .map_err(|_| Error::State("invalid host memory observation"))?;
            if number > 1 << 40 || values.insert(fields[0], number * 1024).is_some() {
                return Err(Error::State("invalid host memory observation"));
            }
        }
    }
    if values.len() != 3 {
        return Err(Error::State("incomplete host memory observation"));
    }
    let result = Capacity {
        total: values["MemTotal:"],
        available: values["MemAvailable:"],
        free: values["MemFree:"],
        ..Default::default()
    };
    if result.total == 0 || result.available > result.total || result.free > result.total {
        return Err(Error::State("inconsistent host memory observation"));
    }
    Ok(result)
}

/// Byte thresholds interpreted by the hardware memory policy, not the supervisor.
#[derive(Clone, Debug)]
pub struct ProtectionPolicy {
    min_available: u64,
    min_free: u64,
    free_gate: u64,
    consecutive: u64,
}
impl ProtectionPolicy {
    pub fn new(
        min_available: u64,
        min_free: u64,
        free_gate: u64,
        consecutive: u64,
    ) -> Result<Self, Error> {
        if min_available == 0 || min_free == 0 || free_gate < min_available || consecutive == 0 {
            return Err(Error::Conflict("invalid memory protection thresholds"));
        }
        Ok(Self {
            min_available,
            min_free,
            free_gate,
            consecutive,
        })
    }
    pub fn for_service(service: &Service) -> Result<Self, Error> {
        service.validate()?;
        let memory = &service.memory;
        Self::new(
            memory.min_available_gib as u64 * GIB,
            memory.min_free_gib as u64 * GIB,
            memory.free_gate_gib as u64 * GIB,
            memory.consecutive_samples as u64,
        )
    }
}
pub struct Watchdog {
    policy: ProtectionPolicy,
    low_samples: u64,
    tripped: bool,
}
impl Watchdog {
    pub fn new(service: &Service) -> Result<Self, Error> {
        Ok(Self::from_policy(ProtectionPolicy::for_service(service)?))
    }
    pub fn from_policy(policy: ProtectionPolicy) -> Self {
        Self {
            policy,
            low_samples: 0,
            tripped: false,
        }
    }
    pub fn sample(&mut self, available: u64, free: u64) -> bool {
        let low = available < self.policy.min_available
            || (free < self.policy.min_free && available < self.policy.free_gate);
        self.low_samples = if low {
            self.low_samples.saturating_add(1)
        } else {
            0
        };
        self.tripped |= self.low_samples >= self.policy.consecutive;
        self.tripped
    }
}

mod capacity;
mod spark;
pub use capacity::check_capacity;
pub(crate) use spark::validate_memory;

#[cfg(target_os = "linux")]
pub mod linux;
pub mod nvidia;

mod observation;
#[cfg(unix)]
pub(crate) use observation::LocalHost;
pub use observation::{HostObservation, HostObserver};

mod ssh;
pub use ssh::SshHost;

#[cfg(test)]
mod tests;
