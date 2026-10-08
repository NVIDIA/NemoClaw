// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! An OpenShell gateway's version and compute drivers, read over its authenticated channel.
pub use nemoclaw_openshell::{capabilities, client, health, remote_error, request};
use nemoclaw_sdk::{
    Secrets,
    config::{ComputeDriver, Gateway},
    discovery::GatewayObservation,
};

/// The gateway's capabilities judged against the drivers its sandboxes require.
/// A failure is an unknown observation, never absence.
pub async fn observe_gateway(
    gateway: &Gateway,
    required: &[ComputeDriver],
    secrets: &dyn Secrets,
) -> GatewayObservation {
    let observed = match client(&gateway.connection(), secrets) {
        Ok(client) => capabilities(&client).await,
        Err(error) => Err(error),
    };
    GatewayObservation::from_result(observed, required)
}
