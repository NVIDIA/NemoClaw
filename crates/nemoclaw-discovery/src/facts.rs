// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Engine, hardware, and image facts read from the selected engine's API.
use crate::engine::Engines;
use nemoclaw_sdk::{
    discovery::{DiscoveryRequest, EngineObservation, ObservationStatus},
    hardware_discovery::HardwareObservation,
};
use std::time::Duration;

/// Observe the selected engine, never substituting the client host for a remote target.
/// Failure to contact the engine leaves capabilities unknown rather than unsupported.
pub async fn observe_engine(
    engines: &dyn Engines,
    request: &DiscoveryRequest,
) -> EngineObservation {
    let mut observed = EngineObservation {
        status: ObservationStatus::Unknown,
        reason: None,
        source: "engine_gateway_prerequisites".into(),
        server_version: None,
        architecture: None,
        operating_system: None,
        memory_bytes: None,
        cpus: None,
    };
    let work = async {
        let engine = engines.engine(&request.engine)?;
        crate::gateway_engine_info(&engine, request.compute_driver).await
    };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(info)) => {
            observed.status = ObservationStatus::Available;
            observed.server_version = info.server_version;
            observed.architecture = info.architecture;
            observed.operating_system = info.os_type;
            observed.memory_bytes = info.mem_total.and_then(|value| value.try_into().ok());
            observed.cpus = info.ncpu;
        }
        Ok(Err(error)) => {
            if matches!(
                error,
                nemoclaw_sdk::Error::Conflict(
                    "managed rootless Podman requires an API that reports pasta networking for OpenShell callbacks"
                        | "Podman sandbox driver requires a Podman engine socket"
                )
            ) {
                observed.status = ObservationStatus::Unavailable;
            }
            observed.reason = Some(error.to_string());
        }
        Err(_) => {
            observed.reason = Some("engine observation timed out".into());
        }
    }
    observed
}

/// Read only the selected engine API. Never run a collector, inspect the client's
/// host, start a probe container, or infer GPU absence from missing advertisements.
pub async fn observe_hardware(engines: &dyn Engines, endpoint: &str) -> HardwareObservation {
    let work = async { engines.engine(endpoint)?.info().await };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(info)) => HardwareObservation::from_info(info),
        _ => {
            let mut observation = HardwareObservation::unknown();
            observation.reason =
                Some("Hardware information from the selected engine is unobservable.".into());
            observation
        }
    }
}
