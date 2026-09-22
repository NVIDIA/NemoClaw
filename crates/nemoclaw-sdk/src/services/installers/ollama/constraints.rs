// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Defaults shared by normalization and schema constraints.
use crate::config::constraints::DefaultedInteger;

pub(super) const PORT: DefaultedInteger = DefaultedInteger {
    default: 18888,
    min: 1024,
    max: 65535,
};
pub(super) const CONTEXT_TOKENS: DefaultedInteger = DefaultedInteger {
    default: 32768,
    min: 8192,
    max: 65536,
};
pub(super) const MAX_SEQUENCES: DefaultedInteger = DefaultedInteger {
    default: 1,
    min: 1,
    max: 2,
};
pub(super) const STARTUP_TIMEOUT: DefaultedInteger = DefaultedInteger {
    default: 1800,
    min: 60,
    max: 3600,
};
pub(super) const GPU_MEMORY: DefaultedInteger = DefaultedInteger {
    default: 0,
    min: 0,
    max: 96,
};
pub(super) const HOST_RESERVE: DefaultedInteger = DefaultedInteger {
    default: 32,
    min: 28,
    max: 64,
};
pub(super) const MIN_AVAILABLE: DefaultedInteger = DefaultedInteger {
    default: 8,
    min: 6,
    max: 16,
};
pub(super) const MIN_FREE: DefaultedInteger = DefaultedInteger {
    default: 3,
    min: 2,
    max: 8,
};
pub(super) const FREE_GATE: DefaultedInteger = DefaultedInteger {
    default: 12,
    min: 6,
    max: 24,
};
pub(super) const CONSECUTIVE_SAMPLES: DefaultedInteger = DefaultedInteger {
    default: 5,
    min: 1,
    max: 5,
};
