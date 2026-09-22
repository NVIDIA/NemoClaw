// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Bounds and option combinations belong to the service schema. Rust compares values.
pub(crate) fn validate_memory(memory: &super::Memory) -> Result<(), crate::config::ConfigError> {
    crate::config::validation::require(
        memory.free_gate_gib >= memory.min_available_gib,
        "memory free gate must be at least the available-memory threshold",
    )
}
