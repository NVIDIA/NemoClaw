// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded read-only observations shared by authoring and provider data sources.
pub use crate::gateway_observation::{GatewayCapabilities, GatewayObservation};
use crate::{config::ComputeDriver, fabric_catalog::FabricCatalog};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationStatus {
    Available,
    Unavailable,
    Unknown,
}

/// Typed facts shared by discovery sessions, authoring, and plan reports.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "observation", rename_all = "snake_case")]
pub enum DiscoveryObservation {
    Engine(crate::discovery::EngineObservation),
    Hardware(crate::hardware_discovery::HardwareObservation),
    Fabric(crate::discovery::FabricObservation),
    Inference(crate::inference_discovery::EndpointObservation),
    Gateway(GatewayObservation),
    Service { ready: Option<bool>, source: String },
    Unresolved { category: String },
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub image_id: Option<String>,
    pub catalog: Option<FabricCatalog>,
    #[serde(default)]
    pub image: crate::fabric_capabilities::ImageMetadata,
    #[serde(default)]
    pub compatibility: Option<crate::fabric_capabilities::CompatibilityReport>,
}
