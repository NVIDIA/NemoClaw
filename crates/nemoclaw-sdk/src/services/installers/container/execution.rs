// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Explicit container settings; application policy remains in its image.
use super::{ServiceIpc, limits::ContainerResources};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
/// Container execution limits, independent of application/model memory policy.
pub struct ContainerExecution {
    /// Expose the engine's GPU devices. Omission leaves GPU access disabled.
    pub gpu: bool,
    /// CPU limit in millicores. Omission leaves CPU usage unrestricted.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u32", range(min = 1, max = 4294967295_u64))]
    pub cpu_limit_millis: Option<u32>,
    /// Container memory limit in GiB; not a GPU-memory reservation. Omission selects 1 GiB.
    #[serde(rename = "memoryLimitGiB", skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64", range(min = 1, max = 8589934591_u64))]
    pub memory_limit_gib: Option<u64>,
    /// Shared memory in GiB. Omission selects 64 MiB.
    #[serde(rename = "sharedMemoryGiB", skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64", range(min = 1, max = 64))]
    pub shared_memory_gib: Option<u64>,
    /// Private IPC by default; host shares the host IPC namespace.
    pub ipc: ServiceIpc,
    /// Process limits by Docker limit name. Each value sets both soft and hard limits; -1 means unlimited.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub ulimits: BTreeMap<String, i64>,
}

impl ContainerExecution {
    pub(super) fn resources(&self) -> Result<ContainerResources, crate::config::ConfigError> {
        let memory_bytes = self
            .memory_limit_gib
            .unwrap_or(1)
            .checked_mul(1 << 30)
            .ok_or_else(|| {
                crate::config::ConfigError::new("container memory limit is too large")
            })?;
        let shared_memory_bytes = self
            .shared_memory_gib
            .map_or(64 << 20, |gib| gib * (1 << 30));
        crate::config::validation::require(
            self.ipc == ServiceIpc::Host || shared_memory_bytes <= memory_bytes,
            "container memory must cover private shared memory",
        )?;
        crate::config::validation::require(
            self.ulimits.values().all(|value| *value >= -1),
            "container process limits must be nonnegative or -1",
        )?;
        Ok(ContainerResources {
            memory_bytes,
            shared_memory_bytes,
            host_ipc: self.ipc == ServiceIpc::Host,
            cpu_limit_millis: self.cpu_limit_millis,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Readiness observation. Omission uses the image's Docker HEALTHCHECK.
pub struct ContainerReadiness {
    /// HTTP GET path on the container's listener. Success requires HTTP 200; redirects are not followed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Managed-runtime status file containing phase and updated. Requires a ready report from this container start, not an old volume's report.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<String>,
    /// Startup wait in seconds, 1–3600. Omission selects 300.
    #[serde(default = "default_timeout")]
    #[schemars(range(min = 1, max = 3600))]
    pub timeout_seconds: u64,
}
fn default_timeout() -> u64 {
    300
}
impl Default for ContainerReadiness {
    fn default() -> Self {
        Self {
            path: None,
            runtime_status: None,
            timeout_seconds: default_timeout(),
        }
    }
}

pub(super) fn absolute_path(path: &str) -> bool {
    path.starts_with('/')
        && path != "/"
        && !path.contains('\0')
        && path[1..]
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}
