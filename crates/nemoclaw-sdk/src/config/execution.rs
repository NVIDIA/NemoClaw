// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;
use crate::config::HarnessKind;
use serde::{Deserialize, Serialize};

/// Execution timeout shared by the sandbox; native heartbeat settings are OpenClaw-only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentExecution {
    /// Agent-turn timeout in seconds. Omission selects 600 for OpenClaw and 300 for other harnesses. OpenClaw adds 60 seconds to the enclosing Fabric timeout; readiness and health checks use separate budgets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32", range(min = 1, max = 1000000000))]
    pub timeout_seconds: Option<u32>,
    /// Heartbeat duration in seconds, minutes, or hours, such as 30m. Zero disables heartbeat. Omission leaves native defaults; an explicit interval uses an isolated heartbeat session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(
        default,
        with = "String",
        length(max = 256),
        regex(pattern = r"^[0-9]+[smh]$")
    )]
    pub heartbeat_every: Option<String>,
}
impl AgentExecution {
    pub(crate) fn validate(&self, harness: HarnessKind) -> Result<(), ConfigError> {
        if (harness != HarnessKind::OpenClaw && self.heartbeat_every.is_some())
            || (self.timeout_seconds.is_none() && self.heartbeat_every.is_none())
            || self
                .timeout_seconds
                .is_some_and(|n| !(1..=1_000_000_000).contains(&n))
            || self.heartbeat_every.as_ref().is_some_and(|value| {
                value.len() > 256
                    || value.len() < 2
                    || !value.as_bytes()[..value.len() - 1]
                        .iter()
                        .all(u8::is_ascii_digit)
                    || !matches!(value.as_bytes().last(), Some(b's' | b'm' | b'h'))
            })
        {
            return Err(ConfigError::new(
                "execution requires a positive timeout; heartbeat requires OpenClaw and a duration ending in s, m, or h",
            ));
        }
        Ok(())
    }
}
