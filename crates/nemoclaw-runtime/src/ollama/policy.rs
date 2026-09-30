// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::ManagedOllama;
use crate::{
    Error,
    hardware::{GIB, ProtectionPolicy},
};

pub fn protection(service: &ManagedOllama) -> Result<ProtectionPolicy, Error> {
    service.validate()?;
    ProtectionPolicy::new(
        service.memory.min_available_gib as u64 * GIB,
        service.memory.min_free_gib as u64 * GIB,
        service.memory.free_gate_gib as u64 * GIB,
        service.memory.consecutive_samples as u64,
    )
}
