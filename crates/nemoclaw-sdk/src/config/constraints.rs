// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Spark memory defaults were informed by MiaAI Lab's start.sh and memwatch.sh.
// Upstream AGPL-3.0-or-later recipe and revision: crates/nemoclaw-sdk/NOTICE.md.
//! Values shared by normalization, validation, and the authored-input schema.

pub(crate) const KIND: &str = "NemoClawConfig";
pub(crate) const SLUG: &str = r"^[a-z][a-z0-9-]{0,39}$";
pub(crate) const UUID: &str = r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
pub(crate) const ENV: &str = r"^[A-Z_][A-Z0-9_]{0,127}$";
pub(crate) const MODEL: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$";
pub(crate) const OLLAMA_MODEL: &str = r"^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$";
pub(crate) const IMAGE: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$";
pub(crate) const REPOSITORY: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$";
pub(crate) const REVISION: &str = r"^[a-f0-9]{40}$";
pub(crate) const MANAGEMENT: &[&str] = &["managed", "external"];
pub(crate) const PROVIDERS: &[&str] = &["openai", "anthropic"];
pub(crate) const RUNTIMES: &[&str] = &["docker", "podman"];
pub(crate) const HARNESSES: &[&str] = &[
    "deepagents",
    "hermes",
    "openclaw",
    "claude",
    "codex",
    "mini-swe-agent",
    "nooa",
    "nooa-bench",
    "remote-agent",
    "pi",
];
pub(crate) const TOOL_PARSERS: &[&str] = &["", "hermes", "qwen3_coder", "llama3_json", "mistral"];
pub(crate) const REASONING_PARSERS: &[&str] = &["", "qwen3", "deepseek_r1", "nemotron_v3"];
pub(crate) const GATEWAY_ENDPOINT: &str = "http://127.0.0.1:17681";
pub(crate) const GATEWAY_ENGINE: &str = "unix:///var/run/docker.sock";
pub(crate) const RUNTIME: &str = "docker";
pub(crate) const NETWORK_TIER: &str = "isolated";
pub(crate) const BACKEND: &str = "vllm";

/// Zero in authored YAML selects the default; validation uses normalized values.
pub(crate) struct DefaultedInteger {
    pub default: i64,
    pub min: i64,
    pub max: i64,
}
impl DefaultedInteger {
    pub fn contains(&self, value: i64) -> bool {
        (self.min..=self.max).contains(&value)
    }
}
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
