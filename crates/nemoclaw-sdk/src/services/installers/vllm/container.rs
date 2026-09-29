// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed inference IPC and shared-memory settings.
pub struct ServiceContainer {
    /// IPC namespace. Omission uses private; host shares the execution host's IPC namespace.
    #[serde(default)]
    pub ipc: ServiceIpc,
    /// Shared-memory size in GiB, from 1 through 64. Omission uses 8; host IPC uses the host's existing shared-memory mount instead.
    #[serde(default = "default_shm")]
    pub shared_memory_gi_b: u64,
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
