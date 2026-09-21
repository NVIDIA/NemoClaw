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
pub(crate) const IMAGE: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$";
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
pub(crate) const GATEWAY_ENDPOINT: &str = "http://127.0.0.1:17681";
pub(crate) const GATEWAY_ENGINE: &str = "unix:///var/run/docker.sock";
pub(crate) const RUNTIME: &str = "docker";
pub(crate) const NETWORK_TIER: &str = "isolated";

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
