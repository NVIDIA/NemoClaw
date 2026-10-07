// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Engine, hardware, and image facts read from the selected engine's API.
use crate::engine::Engines;
use nemoclaw_sdk::{
    discovery::{DiscoveryRequest, EngineObservation, FabricObservation, ObservationStatus},
    fabric_capabilities::{FabricRequirements, ImageMetadata, assess_image},
    fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL},
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
        engines
            .engine(&request.engine)?
            .gateway_engine_info(request.compute_driver)
            .await
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

/// Inspect metadata on an existing image. This never pulls an image or starts a container.
pub async fn observe_fabric(
    engines: &dyn Engines,
    endpoint: &str,
    image: &str,
) -> FabricObservation {
    let mut observed = FabricObservation {
        status: ObservationStatus::Unknown,
        reason: None,
        source: "engine_image_inspect".into(),
        image_id: None,
        catalog: None,
        image: Default::default(),
        compatibility: None,
    };
    let work = async { engines.engine(endpoint)?.image(image).await };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(Some(info))) => {
            observed.image_id = info.id;
            observed.image = ImageMetadata {
                architecture: info.architecture,
                operating_system: info.os,
                repo_digests: info.repo_digests.unwrap_or_default(),
                size_bytes: info.size,
            };
            let label = info
                .config
                .and_then(|config| config.labels)
                .and_then(|labels| labels.get(IMAGE_CATALOG_LABEL).cloned());
            match label.as_deref().map(FabricCatalog::from_json) {
                Some(Ok(catalog))
                    if observed.image_id.as_ref().is_some_and(|id| !id.is_empty()) =>
                {
                    observed.catalog = Some(catalog);
                    observed.status = ObservationStatus::Available;
                }
                Some(_) => {
                    observed.reason = Some("image Fabric metadata is invalid or incomplete".into())
                }
                None => {
                    observed.reason =
                        Some("image does not advertise Fabric capability metadata".into())
                }
            }
        }
        Ok(Ok(None)) => {
            observed.status = ObservationStatus::Unavailable;
            observed.reason = Some("image is not present on the selected engine".into());
        }
        Ok(Err(error)) => observed.reason = Some(error.to_string()),
        Err(_) => observed.reason = Some("image observation timed out".into()),
    }
    observed
}

/// Judge an image read against what its sandbox requires, on the engine
/// platform when one is known.
pub fn judge_image(
    observed: &mut FabricObservation,
    image: &str,
    requirements: &FabricRequirements,
    architecture: Option<&str>,
    operating_system: Option<&str>,
) {
    observed.compatibility = Some(assess_image(
        observed.catalog.as_ref(),
        requirements,
        &observed.image,
        image,
        architecture,
        operating_system,
    ));
}
