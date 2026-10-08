// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Engine prerequisite checks for an OpenShell gateway.
use bollard::models::SystemInfo;
pub use nemoclaw_docker::{Direct, Engine, Engines, is_missing, optional, remote};
use nemoclaw_sdk::{Error, ObservationError, config::ComputeDriver};

/// Read the engine and check existing gateway prerequisites without changing resources.
/// Passing this check does not establish image, GPU, or deployment readiness.
pub async fn gateway_engine_info(
    engine: &Engine,
    driver: ComputeDriver,
) -> Result<SystemInfo, Error> {
    if driver == ComputeDriver::Podman {
        #[cfg(unix)]
        {
            let native = engine.podman_json("info").await?;
            let rootless = native["host"]["security"]["rootless"]
                .as_bool()
                .ok_or(ObservationError::Incomplete)?;
            if rootless && native["host"]["rootlessNetworkCmd"] != serde_json::json!("pasta") {
                return Err(Error::Conflict(
                    "managed rootless Podman requires an API that reports pasta networking for OpenShell callbacks",
                ));
            }
        }
        let version = engine.api.version().await.map_err(|error| remote(&error))?;
        if !version
            .components
            .unwrap_or_default()
            .iter()
            .any(|part| part.name == "Podman Engine")
        {
            return Err(Error::Conflict(
                "Podman sandbox driver requires a Podman engine socket",
            ));
        }
    }
    engine.info().await
}
