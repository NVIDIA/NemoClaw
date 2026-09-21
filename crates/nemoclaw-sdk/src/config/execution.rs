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
        super::schema::validate_harness_field("execution", self, harness)
    }
}
