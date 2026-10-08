// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fabric` OpenTofu provider: Fabric agents hosted in OpenShell
//! sandboxes, reached through the sandbox's Fabric host.

mod agent_configuration;
mod bridge;
mod capabilities;
mod configuration;
#[cfg(all(test, unix))]
mod fixture;
mod provider;
mod sandbox_readiness;

pub use agent_configuration::{AgentConfigurationBackend, definitions};
pub use bridge::{AgentBridge, AgentSnapshot};
pub use capabilities::{FabricCapabilitiesDataSource, FabricCapabilitiesState};
pub use provider::FabricProvider;
pub use sandbox_readiness::{SandboxReadinessDataSource, SandboxReadinessState};
