// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};

/// Docker memory limit for a managed model container without container.memoryLimitGiB.
pub(crate) const DEFAULT_MEMORY_LIMIT_GIB: u64 = 104;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed inference CPU and memory limits, IPC, and shared-memory settings.
pub struct ServiceContainer {
    /// CPU usage limit in millicores. Omission leaves Docker CPU usage unrestricted. Changing the limit replaces the model container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u32", range(min = 1, max = 4294967295_u64))]
    pub cpu_limit_millis: Option<u32>,
    /// Container memory limit in GiB, independent of the model's GPU budget. Omission retains Docker's 104 GiB limit. Changing the limit replaces the model container.
    #[serde(
        rename = "memoryLimitGiB",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "u64", range(min = 1, max = 8589934591_u64))]
    pub memory_limit_gib: Option<u64>,
    /// IPC namespace. Omission uses private; host shares the execution host's IPC namespace.
    #[serde(default)]
    pub ipc: ServiceIpc,
    /// Shared-memory size in GiB, from 1 through 64. Omission uses 8; host IPC uses the host's existing shared-memory mount instead.
    #[serde(default = "default_shm")]
    pub shared_memory_gi_b: u64,
    /// The one GPU the model container gets on a host with several, as `docker run --gpus device=` names it: a UUID from `nvidia-smi --query-gpu=uuid`, such as `GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3`, or an index as a string, such as "1", which can change when the host boots. Omission exposes every GPU, and the model runtime then requires the host to have exactly one. Changing it replaces the model container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String")]
    pub gpu: Option<String>,
}

/// Docker resources of a managed model container.
pub(crate) struct ContainerResources {
    pub shared_memory_bytes: u64,
    pub host_ipc: bool,
    pub cpu_limit_millis: Option<u32>,
    pub memory_bytes: u64,
    pub gpu_device: Option<String>,
}

impl ServiceContainer {
    /// The Docker resources `container` sets, with the defaults for any it omits.
    pub(crate) fn resources(container: Option<&Self>) -> ContainerResources {
        let gib = nemoclaw_runtime::hardware::GIB;
        ContainerResources {
            shared_memory_bytes: container
                .map_or_else(default_shm, |container| container.shared_memory_gi_b)
                * gib,
            host_ipc: container.is_some_and(|container| container.ipc == ServiceIpc::Host),
            cpu_limit_millis: container.and_then(|container| container.cpu_limit_millis),
            memory_bytes: container
                .and_then(|container| container.memory_limit_gib)
                .unwrap_or(DEFAULT_MEMORY_LIMIT_GIB)
                * gib,
            gpu_device: container.and_then(|container| container.gpu.clone()),
        }
    }

    pub(crate) fn validate_memory(
        &self,
        preparation_memory_gib: u64,
    ) -> Result<(), crate::config::ConfigError> {
        if let Some(limit) = self.memory_limit_gib {
            crate::config::validation::require(
                self.ipc == ServiceIpc::Host || self.shared_memory_gi_b <= limit,
                "container.memoryLimitGiB must cover container.sharedMemoryGiB for private IPC",
            )?;
            crate::config::validation::require(
                preparation_memory_gib <= limit,
                "container.memoryLimitGiB must cover recipe preparationMemoryGiB",
            )?;
        }
        Ok(())
    }
}

fn default_shm() -> u64 {
    8
}

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
/// IPC namespace used by the managed inference container.
pub enum ServiceIpc {
    #[default]
    Private,
    Host,
}
