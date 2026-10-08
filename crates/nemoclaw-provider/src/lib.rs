// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The `nemoclaw` OpenTofu provider: platform resources and observations.

pub use nemoclaw_tofu::*;

mod capacity;
mod discovery;
mod gateway;
pub mod hardware;
mod hardware_data;
mod inference_discovery;
pub mod kubernetes;
mod provider;
mod readiness;
mod runtime_contract;
mod runtime_image;
pub use provider::NemoClawProvider;

/// The definition this provider serves for a resource kind.
pub fn resource_definition(kind: &str) -> Option<Definition> {
    provider::definitions()
        .into_iter()
        .find(|definition| definition.kind == kind)
}

/// OpenShell resource operations owned by this provider.
pub use openshell_provider as openshell;

pub mod docker;
pub mod hardware_observation;
pub mod managed;
pub mod services;
pub(crate) use nemoclaw_sdk::{
    CancellationToken, Error, ObservationError, Progress, backend, config,
};

mod download;
pub(crate) use nemoclaw_sdk::{ByteProgress, DownloadPhase};

#[cfg(all(test, unix))]
use nemoclaw_sdk::compile;
