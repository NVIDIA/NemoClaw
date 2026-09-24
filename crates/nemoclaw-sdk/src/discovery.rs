// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded read-only observations shared by authoring and provider data sources.
use crate::{config::ComputeDriver, docker::Connections, fabric_catalog::FabricCatalog};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationStatus {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryRequest {
    pub engine: String,
    pub compute_driver: ComputeDriver,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub server_version: Option<String>,
    pub architecture: Option<String>,
    pub operating_system: Option<String>,
    pub memory_bytes: Option<u64>,
    pub cpus: Option<i64>,
}

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub image_id: Option<String>,
    pub catalog: Option<FabricCatalog>,
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
    };
    let work = async { connections.resolve(endpoint)?.image(image).await };
    match tokio::time::timeout(Duration::from_secs(5), work).await {
        Ok(Ok(Some(info))) => {
            observed.image_id = info.id;
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
