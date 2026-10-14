// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Engine, hardware, and image facts read from the selected engine's API.
use crate::engine::Engines;
use nemoclaw_sdk::{
    discovery::{
        DiscoveryRequest, EngineObservation, GatewayPrerequisitesObservation, ObservationStatus,
    },
    hardware_discovery::HardwareObservation,
};
use std::time::Duration;

/// The gateway prerequisite failures that make an engine unusable for a
/// gateway, rather than unverified.
fn unmet_prerequisite(error: &nemoclaw_sdk::Error) -> bool {
    matches!(
        error,
        nemoclaw_sdk::Error::Conflict(
            "managed rootless Podman requires an API that reports pasta networking for OpenShell callbacks"
                | "Podman sandbox driver requires a Podman engine socket"
        )
    )
}

/// One bounded `/info` read: the engine's reply, its error, or `None` on timeout.
type InfoRead = Option<Result<bollard::models::SystemInfo, nemoclaw_sdk::Error>>;
async fn read_info(engines: &dyn Engines, endpoint: &str) -> InfoRead {
    let work = async { engines.engine(endpoint)?.info().await };
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .ok()
}

/// The selected engine's facts and its advertised hardware from one `/info`
/// read, with the same meaning as [`observe_engine_facts`] and [`observe_hardware`].
pub async fn observe_host(
    engines: &dyn Engines,
    endpoint: &str,
) -> (EngineObservation, HardwareObservation) {
    let info = read_info(engines, endpoint).await;
    (engine_facts(&info), hardware(info))
}

/// The selected engine's facts from its `/info`, whatever runs on it.
/// Failure to contact the engine leaves its facts unknown.
pub async fn observe_engine_facts(engines: &dyn Engines, engine: &str) -> EngineObservation {
    engine_facts(&read_info(engines, engine).await)
}

fn engine_facts(info: &InfoRead) -> EngineObservation {
    let mut observed = EngineObservation::unknown("engine observation timed out");
    match info {
        Some(Ok(info)) => {
            let info = info.clone();
            observed.status = ObservationStatus::Available;
            observed.reason = None;
            observed.server_version = info.server_version;
            observed.architecture = info.architecture;
            observed.operating_system = info.os_type;
            observed.memory_bytes = info.mem_total.and_then(|value| value.try_into().ok());
            observed.cpus = info.ncpu;
        }
        Some(Err(error)) => observed.reason = Some(error.to_string()),
        None => {}
    }
    observed
}

/// Whether the selected engine meets a managed gateway's prerequisites for
/// its compute driver. An unmet prerequisite is unavailable; a failed read is
/// unknown.
pub async fn observe_gateway_prerequisites(
    engines: &dyn Engines,
    request: &DiscoveryRequest,
) -> GatewayPrerequisitesObservation {
    let work = async {
        let engine = engines.engine(&request.engine)?;
        crate::gateway_engine_info(&engine, request.compute_driver).await
    };
    let (status, reason) = match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(_)) => (ObservationStatus::Available, None),
        Ok(Err(error)) if unmet_prerequisite(&error) => {
            (ObservationStatus::Unavailable, Some(error.to_string()))
        }
        Ok(Err(error)) => (ObservationStatus::Unknown, Some(error.to_string())),
        Err(_) => (
            ObservationStatus::Unknown,
            Some("gateway prerequisite observation timed out".into()),
        ),
    };
    GatewayPrerequisitesObservation { status, reason }
}

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
            if unmet_prerequisite(&error) {
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
    hardware(read_info(engines, endpoint).await)
}

fn hardware(info: InfoRead) -> HardwareObservation {
    match info {
        Some(Ok(info)) => HardwareObservation::from_info(info),
        _ => {
            let mut observation = HardwareObservation::unknown();
            observation.reason =
                Some("Hardware information from the selected engine is unobservable.".into());
            observation
        }
    }
}
