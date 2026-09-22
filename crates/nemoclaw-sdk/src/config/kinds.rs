// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

/// Fabric harness implementation selected for a sandbox.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[schemars(inline)]
pub enum HarnessKind {
    #[serde(rename = "deepagents")]
    DeepAgents,
    #[serde(rename = "hermes")]
    Hermes,
    #[serde(rename = "openclaw")]
    OpenClaw,
    #[serde(rename = "claude")]
    Claude,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "mini-swe-agent")]
    MiniSweAgent,
    #[serde(rename = "nooa")]
    Nooa,
    #[serde(rename = "nooa-bench")]
    NooaBench,
    #[serde(rename = "remote-agent")]
    RemoteAgent,
    #[serde(rename = "pi")]
    Pi,
}
impl HarnessKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DeepAgents => "deepagents",
            Self::Hermes => "hermes",
            Self::OpenClaw => "openclaw",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::MiniSweAgent => "mini-swe-agent",
            Self::Nooa => "nooa",
            Self::NooaBench => "nooa-bench",
            Self::RemoteAgent => "remote-agent",
            Self::Pi => "pi",
        }
    }
}
impl fmt::Display for HarnessKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
impl FromStr for HarnessKind {
    type Err = super::ConfigError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "deepagents" => Ok(Self::DeepAgents),
            "hermes" => Ok(Self::Hermes),
            "openclaw" => Ok(Self::OpenClaw),
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "mini-swe-agent" => Ok(Self::MiniSweAgent),
            "nooa" => Ok(Self::Nooa),
            "nooa-bench" => Ok(Self::NooaBench),
            "remote-agent" => Ok(Self::RemoteAgent),
            "pi" => Ok(Self::Pi),
            _ => Err(super::ConfigError::new("unsupported harness kind")),
        }
    }
}

/// Container engine used to run a sandbox or managed process.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
    Default,
)]
#[schemars(inline)]
pub enum ComputeDriver {
    #[default]
    #[serde(rename = "docker")]
    Docker,
    #[serde(rename = "podman")]
    Podman,
}
impl ComputeDriver {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
        }
    }
}
impl fmt::Display for ComputeDriver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
impl FromStr for ComputeDriver {
    type Err = super::ConfigError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "docker" => Ok(Self::Docker),
            "podman" => Ok(Self::Podman),
            _ => Err(super::ConfigError::new("unsupported compute driver")),
        }
    }
}

/// Inference provider implementation, independent of the request API and provider name.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, schemars::JsonSchema,
)]
#[schemars(inline)]
pub enum InferenceProviderKind {
    #[serde(rename = "openai")]
    Openai,
    #[serde(rename = "anthropic")]
    Anthropic,
}
impl InferenceProviderKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
        }
    }
}
impl fmt::Display for InferenceProviderKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
impl FromStr for InferenceProviderKind {
    type Err = super::ConfigError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "openai" => Ok(Self::Openai),
            "anthropic" => Ok(Self::Anthropic),
            _ => Err(super::ConfigError::new(
                "unsupported inference provider kind",
            )),
        }
    }
}

// Empty input is a legacy runtime default, not a compute-driver variant.
pub(super) fn runtime_driver<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<ComputeDriver, D::Error> {
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        Ok(ComputeDriver::Docker)
    } else {
        value.parse().map_err(serde::de::Error::custom)
    }
}
