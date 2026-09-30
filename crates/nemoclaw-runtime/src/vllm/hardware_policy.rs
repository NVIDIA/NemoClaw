// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! vLLM memory-protection policy derived from installer configuration.

use super::Service;
use crate::{
    Error,
    hardware::{GIB, ProtectionPolicy, Watchdog},
};

impl ProtectionPolicy {
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

impl Watchdog {
    pub fn new(service: &Service) -> Result<Self, Error> {
        Ok(Self::from_policy(ProtectionPolicy::for_service(service)?))
    }
}
