// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! vLLM-specific authored-input constraints and defaults.

use crate::config::constraints::DefaultedInteger;

pub(crate) const REPOSITORY: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$";
pub(crate) const REVISION: &str = r"^[a-f0-9]{40}$";
pub(crate) const TOOL_PARSERS: &[&str] = &[
    "",
    "hermes",
    "qwen3_coder",
    "qwen3_xml",
    "llama3_json",
    "mistral",
];
pub(crate) const REASONING_PARSERS: &[&str] = &["", "qwen3", "deepseek_r1", "nemotron_v3"];
pub(crate) const PORT: DefaultedInteger = DefaultedInteger {
    default: 18888,
    min: 1024,
    max: 65535,
};
pub(crate) const CONTEXT_TOKENS: DefaultedInteger = DefaultedInteger {
    default: 32768,
    min: 8192,
    max: 65536,
};
pub(crate) const MAX_SEQUENCES: DefaultedInteger = DefaultedInteger {
    default: 1,
    min: 1,
    max: 2,
};
pub(crate) const BATCH_TOKENS: DefaultedInteger = DefaultedInteger {
    default: 1024,
    min: 512,
    max: 4096,
};
pub(crate) const STARTUP_TIMEOUT: DefaultedInteger = DefaultedInteger {
    default: 1800,
    min: 60,
    max: 3600,
};
pub(crate) const HOST_RESERVE: DefaultedInteger = DefaultedInteger {
    default: 32,
    min: 28,
    max: 64,
};
pub(crate) const KV_CACHE: DefaultedInteger = DefaultedInteger {
    default: 8,
    min: 4,
    max: 12,
};
pub(crate) const MIN_AVAILABLE: DefaultedInteger = DefaultedInteger {
    default: 8,
    min: 6,
    max: 16,
};
pub(crate) const MIN_FREE: DefaultedInteger = DefaultedInteger {
    default: 3,
    min: 2,
    max: 8,
};
pub(crate) const FREE_GATE: DefaultedInteger = DefaultedInteger {
    default: 12,
    min: 6,
    max: 24,
};
pub(crate) const CONSECUTIVE_SAMPLES: DefaultedInteger = DefaultedInteger {
    default: 5,
    min: 1,
    max: 5,
};
pub(crate) const SPECULATIVE_TOKENS_MAX: i64 = 3;
pub(crate) const GPU_MEMORY_MAX: i64 = 96;
pub(crate) const GPU_MEMORY_DEFAULT: i64 = 16;
