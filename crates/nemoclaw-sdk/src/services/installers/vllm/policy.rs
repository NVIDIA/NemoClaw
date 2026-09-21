// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::constraints as c;

pub(crate) fn validate_memory(memory: &super::Memory) -> Result<(), crate::config::ConfigError> {
    fn require(condition: bool, message: &'static str) -> Result<(), crate::config::ConfigError> {
        if condition {
            Ok(())
        } else {
            Err(crate::config::ConfigError::new(message))
        }
    }
    require(
        c::HOST_RESERVE.contains(memory.host_reserve_gib)
            && (if memory.gpu_memory_utilization.is_some() {
                memory.kv_cache_gib == 0
            } else {
                c::KV_CACHE.contains(memory.kv_cache_gib)
            })
            && c::MIN_AVAILABLE.contains(memory.min_available_gib)
            && c::MIN_FREE.contains(memory.min_free_gib)
            && c::FREE_GATE.contains(memory.free_gate_gib)
            && memory.free_gate_gib >= memory.min_available_gib
            && c::CONSECUTIVE_SAMPLES.contains(memory.consecutive_samples),
        "memory policy exceeds supported bounds",
    )
}
