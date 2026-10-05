// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Helpers shared by the authoring tests.
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, Gateway},
    discovery::{DiscoveryRequest, EngineObservation, FabricObservation, ObservationStatus},
    discovery_session::{DiscoveryObservation, DiscoveryObservations, DiscoveryQuery},
    fabric_capabilities::ImageMetadata,
    fabric_catalog::{BridgeCapabilities, FabricCatalog},
};

/// The engine, compute driver, and image a document's target is read through.
pub struct Target {
    pub engine: String,
    pub compute_driver: ComputeDriver,
    pub image: String,
}

/// Read a one-sandbox document's target directly, independently of the code under test.
pub fn target(document: &Document) -> Target {
    let sandbox = &document.spec.sandboxes[0];
    Target {
        engine: match &document.spec.gateway {
            Gateway::Managed(gateway) => gateway.engine.clone(),
            Gateway::External(gateway) => gateway.engine.clone(),
        },
        compute_driver: sandbox.runtime.provider,
        image: sandbox.image.ref_.clone(),
    }
}

/// Observed images must advertise the Fabric bridge to be compatible.
pub fn installed_catalog() -> FabricCatalog {
    let mut catalog = FabricCatalog::bundled();
    catalog.bridge = Some(BridgeCapabilities {
        interface_version: 1,
        operations: [
            "validate",
            "prepare",
            "configure",
            "check",
            "invoke",
            "serve",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        health_checks: Vec::new(),
    });
    catalog
}

/// An engine that is available and runs the example's ARM64 Linux image.
pub fn available_engine() -> EngineObservation {
    EngineObservation {
        status: ObservationStatus::Available,
        reason: None,
        source: "fixture".into(),
        server_version: Some("1".into()),
        architecture: Some("aarch64".into()),
        operating_system: Some("linux".into()),
        memory_bytes: None,
        cpus: None,
    }
}

/// An engine that does not meet the gateway's prerequisites.
pub fn rejecting_engine() -> EngineObservation {
    EngineObservation {
        status: ObservationStatus::Unavailable,
        reason: Some("engine rejected the target".into()),
        source: "fixture".into(),
        server_version: None,
        architecture: None,
        operating_system: None,
        memory_bytes: None,
        cpus: None,
    }
}

/// The document's image, present on the engine with an installed Fabric catalog.
pub fn installed_image(document: &Document) -> FabricObservation {
    FabricObservation {
        status: ObservationStatus::Available,
        reason: None,
        source: "fixture".into(),
        image_id: Some("sha256:observed".into()),
        catalog: Some(installed_catalog()),
        image: ImageMetadata {
            architecture: Some("arm64".into()),
            operating_system: Some("linux".into()),
            repo_digests: vec![target(document).image],
            ..Default::default()
        },
        compatibility: None,
    }
}

/// The observations a journey would hold after reading `document`'s engine and
/// image, recorded under that document's own engine, driver, and image.
pub fn target_observations(
    document: &Document,
    engine: Option<EngineObservation>,
    fabric: Option<FabricObservation>,
) -> DiscoveryObservations {
    let target = target(document);
    let mut observations = DiscoveryObservations::new();
    if let Some(engine) = engine {
        observations.record(
            DiscoveryQuery::Engine(DiscoveryRequest {
                engine: target.engine.clone(),
                compute_driver: target.compute_driver,
            }),
            DiscoveryObservation::Engine(engine),
        );
    }
    if let Some(fabric) = fabric {
        observations.record(
            DiscoveryQuery::Fabric {
                engine: target.engine,
                image: target.image,
            },
            DiscoveryObservation::Fabric(fabric),
        );
    }
    observations
}
