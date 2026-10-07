// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! What a deployment needs to know about its target, and what each read reports.
pub use crate::gateway_observation::{GatewayCapabilities, GatewayObservation};
use crate::{
    config::{ComputeDriver, ConfigError, Document, Gateway},
    fabric_capabilities::FabricRequirements,
    fabric_catalog::FabricCatalog,
    inference_discovery::EndpointRequest,
};
use serde::{Deserialize, Serialize};

/// A read of the target, identified by everything that determines its answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiscoveryQuery {
    Engine(DiscoveryRequest),
    Hardware {
        engine: String,
    },
    /// An image read, judged against what its sandbox requires.
    Fabric {
        engine: String,
        image: String,
        requirements: FabricRequirements,
        /// The engine whose platform the image must run on: a managed
        /// gateway's. An external gateway's image store does not establish it.
        platform: Option<DiscoveryRequest>,
        /// On Kubernetes and OpenShift, where no engine can inspect the image,
        /// the environment variable naming its metadata bundle.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        metadata_env: Option<String>,
    },
    Inference(EndpointRequest),
    Gateway {
        gateway: Gateway,
        compute_drivers: Vec<ComputeDriver>,
    },
    /// Whether a credential reference resolves locally; never its value.
    Credential {
        reference: String,
    },
}

/// The reads a plan makes of the target for `document`, in the order it names
/// them: the gateway, each external inference endpoint, the hardware of every
/// engine that services or a managed gateway use, a managed gateway's engine,
/// and one image read per sandbox. The image reads are per sandbox, sorted by
/// sandbox name, because each carries that sandbox's own requirements, and a
/// managed gateway's image reads run on its engine's platform.
pub fn plan_queries(document: &Document) -> Result<Vec<DiscoveryQuery>, ConfigError> {
    let mut queries = vec![DiscoveryQuery::Gateway {
        gateway: document.spec.gateway.clone(),
        compute_drivers: vec![document.spec.gateway.runtime().provider],
    }];
    queries.extend(
        crate::inference_discovery::endpoint_requests(document)
            .map_err(|_| ConfigError::new("inference discovery inputs are invalid"))?
            .into_iter()
            .map(DiscoveryQuery::Inference),
    );
    let mut engines = crate::services::discovery_engines(document)?;
    if let Some(gateway) = document.spec.gateway.as_local_managed() {
        engines.insert(gateway.engine.clone());
    }
    queries.extend(
        engines
            .into_iter()
            .map(|engine| DiscoveryQuery::Hardware { engine }),
    );
    // A cluster has no engine to read images from; their metadata bundles
    // answer instead.
    let kubernetes = document.spec.gateway.runtime().provider.is_kubernetes();
    let engine = match &document.spec.gateway {
        _ if kubernetes => "",
        Gateway::Managed(gateway) => &gateway.engine,
        Gateway::External(gateway) => &gateway.engine,
    };
    let platform = document
        .spec
        .gateway
        .as_local_managed()
        .map(|_| DiscoveryRequest {
            engine: engine.into(),
            compute_driver: document.spec.gateway.runtime().provider,
        });
    queries.extend(platform.clone().map(DiscoveryQuery::Engine));
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by(|left, right| left.name.cmp(&right.name));
    for sandbox in sandboxes {
        queries.push(DiscoveryQuery::Fabric {
            engine: engine.into(),
            image: sandbox.image.ref_.clone(),
            requirements: FabricRequirements::for_sandbox(document, sandbox)?,
            platform: platform.clone(),
            metadata_env: sandbox
                .image
                .metadata
                .as_ref()
                .map(|metadata| metadata.env.clone()),
        });
    }
    Ok(queries)
}

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
