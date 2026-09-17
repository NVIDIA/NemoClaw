// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Native interfaces belonging to the sandbox harness runtime.
pub struct OpenClawInterfaces {
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
/// Harness-specific native interfaces; OpenClaw uses gateway settings, Hermes uses separate services.
pub enum AgentInterfaces {
    OpenClaw(OpenClawInterfaces),
    Hermes(HermesInterfaces),
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Native Hermes services. Declare at least one override; defaults enable the dashboard and browser chat.
pub struct HermesInterfaces {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "HermesDashboard")]
    /// Dashboard service settings; omitted settings enable port 18789 with internal port 19119.
    pub dashboard: Option<HermesDashboard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "HermesApi")]
    /// Authenticated HTTP API settings. Omitting api selects port 8642; declaring api requires port.
    pub api: Option<HermesApi>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Hermes HTTP API listener inside the sandbox; host access requires OpenShell forwarding.
pub struct HermesApi {
    #[schemars(range(min = 8642, max = 8652))]
    /// Sandbox-local API port, from 8642 through 8652.
    pub port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// Native Hermes dashboard with isolated configuration and active sessions.
pub struct HermesDashboard {
    /// Start the dashboard. When false, all other dashboard fields must be omitted.
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u16", range(min = 1024))]
    /// Sandbox dashboard access port; defaults to 18789. Must differ from internalPort and reserved API ports.
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u16", range(min = 1024))]
    /// Native dashboard listener behind the local forwarder; defaults to 19119 and must differ from port.
    pub internal_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "HermesTui")]
    /// Enable native browser chat/TUI; omitted settings preserve the pinned Hermes default of enabled.
    pub tui: Option<HermesTui>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Browser chat/TUI availability; standalone terminal access remains native Hermes behavior.
pub struct HermesTui {
    /// Permit browser chat and its WebSocket session endpoints.
    pub enabled: bool,
}
impl AgentInterfaces {
    pub fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        let valid = match self {
            Self::OpenClaw(i) => {
                let d = &i.dashboard;
                harness == "openclaw"
                    && (d.port.is_some() || d.bind.is_some())
                    && d.port
                        .is_none_or(|p| p >= 1024 && !(8642..=8652).contains(&p))
            }
            Self::Hermes(i) => {
                harness == "hermes"
                    && (i.dashboard.is_some() || i.api.is_some())
                    && i.api
                        .as_ref()
                        .is_none_or(|a| (8642..=8652).contains(&a.port))
                    && i.dashboard.as_ref().is_none_or(|d| {
                        if !d.enabled {
                            return d.port.is_none()
                                && d.internal_port.is_none()
                                && d.tui.is_none();
                        }
                        let port = d.port.unwrap_or(18789);
                        let internal = d.internal_port.unwrap_or(19119);
                        port != internal
                            && [port, internal]
                                .into_iter()
                                .all(|p| p >= 1024 && !(8642..=8652).contains(&p) && p != 18642)
                    })
            }
        };
        if valid {
            Ok(())
        } else {
            Err(ConfigError::new(
                "invalid or unsupported native interface settings",
            ))
        }
    }
}
