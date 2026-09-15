// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;
use serde::{Deserialize, Serialize};

/// OpenClaw execution defaults shared by the sandbox. Declare only on the first agent; other agents use the same native defaults.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentExecution {
    /// Agent-turn timeout in seconds. Omission selects 600; readiness and health checks use separate budgets.
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
    pub(crate) fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        if harness != "openclaw"
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
            return Err(ConfigError(
                "execution requires OpenClaw, a positive timeout or a heartbeat duration ending in s, m, or h",
            ));
        }
        Ok(())
    }
}
