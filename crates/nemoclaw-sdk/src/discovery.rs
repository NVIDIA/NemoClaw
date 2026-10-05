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

/// What a target read reports, given only its query's inputs. Plan and
/// onboarding share these facts; a read that needs a plan's own resources is a
/// `PlanObservation` instead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "observation", rename_all = "snake_case")]
pub enum DiscoveryObservation {
    Engine(crate::discovery::EngineObservation),
    Hardware(crate::hardware_discovery::HardwareObservation),
    Fabric(crate::discovery::FabricObservation),
    Inference(crate::inference_discovery::EndpointObservation),
    Gateway(GatewayObservation),
    Credential(crate::inference_discovery::CredentialObservation),
}

impl DiscoveryObservation {
    pub fn status(&self) -> ObservationStatus {
        match self {
            Self::Engine(value) => value.status,
            Self::Hardware(value) => value.status,
            Self::Fabric(value) => value.status,
            Self::Inference(value) => value.status,
            Self::Gateway(value) => value.status,
            Self::Credential(value) => value.status,
        }
    }
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

impl EngineObservation {
    /// A read that could not be made, recorded as unknown rather than absent.
    pub fn unknown(reason: &str) -> Self {
        Self {
            status: ObservationStatus::Unknown,
            reason: Some(reason.into()),
            source: "engine_info".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }
    }
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

impl FabricObservation {
    /// A read that could not be made, recorded as unknown rather than absent.
    pub fn unknown(reason: &str) -> Self {
        Self {
            status: ObservationStatus::Unknown,
            reason: Some(reason.into()),
            source: "engine_image_inspect".into(),
            image_id: None,
            catalog: None,
            image: Default::default(),
            compatibility: None,
        }
    }
}

/// Compatibility of a managed inference image with the compiled runtime contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeImageObservation {
    pub status: ObservationStatus,
    pub source: String,
    pub required_version: String,
}
