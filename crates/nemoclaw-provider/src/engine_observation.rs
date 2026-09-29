// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::docker::Connections;
use nemoclaw_sdk::fabric_catalog::FabricCatalog;
use nemoclaw_sdk::{
    discovery::DiscoveryRequest, discovery::EngineObservation, discovery::FabricObservation,
    discovery::ObservationStatus,
};
use std::time::Duration;
/// Observe the selected engine, never substituting the client host for a remote target.
/// Failure to contact the engine leaves capabilities unknown rather than unsupported.
pub async fn observe_engine(
    connections: &Connections,
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
        connections
            .resolve(&request.engine)?
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
                crate::Error::Conflict(
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

/// Inspect metadata on an existing image. This never pulls an image or starts a container.
pub async fn observe_fabric(
    connections: &Connections,
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
    let work = async { connections.resolve(endpoint)?.image(image).await };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(Some(info))) => {
            observed.image_id = info.id;
            observed.image = crate::fabric_capabilities::ImageMetadata {
                architecture: info.architecture,
                operating_system: info.os,
                repo_digests: info.repo_digests.unwrap_or_default(),
                size_bytes: info.size,
            };
            let label = info
                .config
                .and_then(|config| config.labels)
                .and_then(|labels| {
                    labels
                        .get(crate::fabric_catalog::IMAGE_CATALOG_LABEL)
                        .cloned()
                });
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
