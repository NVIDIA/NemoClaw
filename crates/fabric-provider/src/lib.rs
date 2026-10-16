// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fabric` OpenTofu provider: Fabric agents hosted in OpenShell
//! sandboxes, reached through the sandbox's Fabric host.

mod agent;
mod agent_readiness;
mod bridge;
mod capabilities;
mod configuration;
#[cfg(test)]
mod fake_gateway_tests;
#[cfg(all(test, unix))]
mod fixture;
mod provider;

pub use agent::{AgentBackend, definitions};
pub use agent_readiness::{AgentReadinessDataSource, AgentReadinessState};
pub use bridge::{AgentBridge, AgentSnapshot};
pub use capabilities::{
    FabricCapabilitiesDataSource, FabricCapabilitiesState, FabricHarnessDataSource,
    FabricHarnessState, HARNESS_TYPE,
};
pub use configuration::fabric_binding;
pub use provider::FabricProvider;
