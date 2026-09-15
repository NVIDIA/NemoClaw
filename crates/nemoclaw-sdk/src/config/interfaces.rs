// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Native agent interfaces. Declare once on the first agent in a shared sandbox.
pub struct AgentInterfaces {
    /// Enable the OpenClaw dashboard with sandbox-local token authentication.
    pub dashboard: OpenClawDashboard,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// OpenClaw gateway settings. At least one field is required; omitted fields use native deployment defaults.
pub struct OpenClawDashboard {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u16", range(min = 1024))]
    /// Sandbox gateway port; defaults to 18789. Ports 8642 through 8652 are reserved for Hermes.
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "DashboardBind")]
    /// Sandbox bind address; defaults to loopback. Host publication still requires OpenShell forwarding.
    pub bind: Option<DashboardBind>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// Address on which the native dashboard listens inside the sandbox.
pub enum DashboardBind {
    #[serde(rename = "127.0.0.1")]
    Loopback,
    #[serde(rename = "0.0.0.0")]
    All,
}
impl AgentInterfaces {
    pub fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        let d = &self.dashboard;
        if harness != "openclaw"
            || (d.port.is_none() && d.bind.is_none())
            || d.port
                .is_some_and(|p| p < 1024 || (8642..=8652).contains(&p))
        {
            return Err(ConfigError(
                "OpenClaw dashboard requires a bind or an unreserved unprivileged port",
            ));
        }
        Ok(())
    }
}
