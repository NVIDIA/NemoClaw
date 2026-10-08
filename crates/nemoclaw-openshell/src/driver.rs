// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_backend::ConfigError;
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

/// OpenShell compute driver selected for a sandbox or managed process.
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
    #[serde(rename = "kubernetes")]
    Kubernetes,
    #[serde(rename = "openshift")]
    OpenShift,
}
impl ComputeDriver {
    /// Cluster-backed profiles share the upstream Kubernetes compute driver.
    pub const fn is_kubernetes(self) -> bool {
        matches!(self, Self::Kubernetes | Self::OpenShift)
    }

    /// Driver advertised and served by the pinned OpenShell gateway.
    pub const fn openshell_driver(self) -> Self {
        match self {
            Self::OpenShift => Self::Kubernetes,
            driver => driver,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
            Self::Kubernetes => "kubernetes",
            Self::OpenShift => "openshift",
        }
    }
}
impl fmt::Display for ComputeDriver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
impl FromStr for ComputeDriver {
    type Err = ConfigError;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "docker" => Ok(Self::Docker),
            "podman" => Ok(Self::Podman),
            "kubernetes" => Ok(Self::Kubernetes),
            "openshift" => Ok(Self::OpenShift),
            _ => Err(ConfigError::new("unsupported compute driver")),
        }
    }
}
