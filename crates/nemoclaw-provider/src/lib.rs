// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The `nemoclaw` OpenTofu provider: platform resources and observations.

pub use nemoclaw_tofu::*;

mod capacity;
mod discovery;
#[cfg(all(test, target_os = "linux"))]
#[path = "../../test-support/executable.rs"]
mod executable;
mod gateway;
pub mod hardware;
mod host_container_health;
mod host_engine;
mod host_image;
pub mod kubernetes;
mod ollama_model;
mod provider;
mod readiness;
mod runtime_contract;
pub use provider::{GatewayInstallation, HostProvider, ServiceProvider};

/// The definition this crate implements for a resource kind, whichever
/// provider serves it.
pub fn resource_definition(kind: &str) -> Option<Definition> {
    provider::all_definitions()
        .into_iter()
        .find(|definition| definition.kind == kind)
}

/// OpenShell resource operations owned by this provider.
pub mod docker;
pub mod hardware_observation;
pub mod managed;
pub mod services;
pub(crate) use nemoclaw_sdk::{
    CancellationToken, Error, ObservationError, Progress, backend, config,
};

mod download;
pub(crate) use nemoclaw_sdk::{ByteProgress, DownloadPhase};

#[cfg(test)]
use nemoclaw_sdk::compile;
