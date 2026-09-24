// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

/// Fabric harness identifier. Named variants retain existing native integrations;
/// other validated identifiers are dispatched through Fabric's generic contract.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HarnessKind {
    DeepAgents,
    Hermes,
    OpenClaw,
    Claude,
    Codex,
    MiniSweAgent,
    Nooa,
    NooaBench,
    RemoteAgent,
    Pi,
    Other(String),
}
impl HarnessKind {
    pub fn as_str(&self) -> &str {
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
            Self::Other(value) => value,
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
        if value.is_empty()
            || value.len() > 63
            || !value.as_bytes()[0].is_ascii_lowercase()
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(super::ConfigError::new("invalid Fabric harness identifier"));
        }
        Ok(match value {
            "deepagents" => Self::DeepAgents,
            "hermes" => Self::Hermes,
            "openclaw" => Self::OpenClaw,
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            "mini-swe-agent" => Self::MiniSweAgent,
            "nooa" => Self::Nooa,
            "nooa-bench" => Self::NooaBench,
            "remote-agent" => Self::RemoteAgent,
            "pi" => Self::Pi,
            _ => Self::Other(value.to_owned()),
        })
    }
}
impl Serialize for HarnessKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}
impl<'de> Deserialize<'de> for HarnessKind {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}
impl schemars::JsonSchema for HarnessKind {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "HarnessKind".into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({"type":"string", "pattern":"^[a-z][a-z0-9-]{0,62}$(?![\\s\\S])", "minLength":1, "maxLength":63})
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
