// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::ConfigError;
use crate::config::HarnessKind;
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
/// Native Hermes dashboard, either disabled or enabled with service settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(try_from = "HermesDashboardInput", into = "HermesDashboardInput")]
#[schemars(with = "HermesDashboardInput")]
pub enum HermesDashboard {
    /// Do not start the dashboard service.
    Disabled,
    /// Start the dashboard using the supplied overrides and native defaults.
    Enabled(HermesDashboardSettings),
}

/// Settings that apply only to an enabled Hermes dashboard.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HermesDashboardSettings {
    /// Sandbox access port; defaults to 18789.
    pub port: Option<u16>,
    /// Native listener behind the forwarder; defaults to 19119.
    pub internal_port: Option<u16>,
    /// Browser chat availability; omission preserves the native enabled default.
    pub tui: Option<HermesTui>,
}

// Preserve the authored enabled flag at the boundary, without allowing disabled
// dashboards to carry settings in the SDK.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[schemars(rename = "HermesDashboard")]
/// Native Hermes dashboard with isolated configuration and active sessions.
struct HermesDashboardInput {
    /// Start the dashboard. When false, all other dashboard fields must be omitted.
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u16", range(min = 1024))]
    /// Sandbox dashboard access port; defaults to 18789. Must differ from internalPort and reserved API ports.
    port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u16", range(min = 1024))]
    /// Native dashboard listener behind the local forwarder; defaults to 19119 and must differ from port.
    internal_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "HermesTui")]
    /// Enable native browser chat/TUI; omitted settings preserve the pinned Hermes default of enabled.
    tui: Option<HermesTui>,
}
impl TryFrom<HermesDashboardInput> for HermesDashboard {
    type Error = ConfigError;

    fn try_from(input: HermesDashboardInput) -> Result<Self, Self::Error> {
        match input {
            HermesDashboardInput {
                enabled: true,
                port,
                internal_port,
                tui,
            } => Ok(Self::Enabled(HermesDashboardSettings {
                port,
                internal_port,
                tui,
            })),
            HermesDashboardInput {
                enabled: false,
                port: None,
                internal_port: None,
                tui: None,
            } => Ok(Self::Disabled),
            _ => Err(ConfigError::new("disabled dashboard cannot have settings")),
        }
    }
}

impl From<HermesDashboard> for HermesDashboardInput {
    fn from(dashboard: HermesDashboard) -> Self {
        match dashboard {
            HermesDashboard::Disabled => Self {
                enabled: false,
                port: None,
                internal_port: None,
                tui: None,
            },
            HermesDashboard::Enabled(settings) => Self {
                enabled: true,
                port: settings.port,
                internal_port: settings.internal_port,
                tui: settings.tui,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Browser chat/TUI availability; standalone terminal access remains native Hermes behavior.
pub struct HermesTui {
    /// Permit browser chat and its WebSocket session endpoints.
    pub enabled: bool,
}
impl AgentInterfaces {
    pub fn validate(&self, harness: HarnessKind) -> Result<(), ConfigError> {
        super::schema::validate_harness_field("interfaces", self, harness)?;
        if let Self::Hermes(interfaces) = self
            && let Some(HermesDashboard::Enabled(dashboard)) = &interfaces.dashboard
            && dashboard.port.unwrap_or(18789) == dashboard.internal_port.unwrap_or(19119)
        {
            return Err(ConfigError::new("Hermes dashboard ports must differ"));
        }
        Ok(())
    }
}
