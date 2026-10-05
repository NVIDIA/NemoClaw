// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Helpers shared by the authoring tests.
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, Gateway},
    discovery::{DiscoveryRequest, EngineObservation, FabricObservation, ObservationStatus},
    discovery_session::{DiscoveryObservation, DiscoveryObservations, DiscoveryQuery, plan_queries},
    fabric_capabilities::{ImageMetadata, assess_image},
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

/// The plan's read of `document`'s sandbox image, as the SDK names it.
pub fn image_query(document: &Document) -> DiscoveryQuery {
    plan_queries(document)
        .unwrap()
        .into_iter()
        .find(|query| matches!(query, DiscoveryQuery::Fabric { .. }))
        .unwrap()
}

/// What the provider returns for `query`: the raw image read judged against the
/// query's requirements, on its engine's platform when it names one.
pub fn judged(
    query: &DiscoveryQuery,
    mut fabric: FabricObservation,
    engine: Option<&EngineObservation>,
) -> FabricObservation {
    let DiscoveryQuery::Fabric {
        image,
        requirements,
        platform,
        ..
    } = query
    else {
        panic!("an image query")
    };
    let platform = engine.filter(|_| platform.is_some());
    fabric.compatibility = Some(assess_image(
        fabric.catalog.as_ref(),
        requirements,
        &fabric.image,
        image,
        platform.and_then(|engine| engine.architecture.as_deref()),
        platform.and_then(|engine| engine.operating_system.as_deref()),
    ));
    fabric
}

/// The observations a journey would hold after reading `document`'s engine and
/// image, recorded under that document's own reads as a provider returns them.
pub fn target_observations(
    document: &Document,
    engine: Option<EngineObservation>,
    fabric: Option<FabricObservation>,
) -> DiscoveryObservations {
    let target = target(document);
    let mut observations = DiscoveryObservations::new();
    if let Some(fabric) = fabric {
        let query = image_query(document);
        let fabric = judged(&query, fabric, engine.as_ref());
        observations.record(query, DiscoveryObservation::Fabric(fabric));
    }
    if let Some(engine) = engine {
        observations.record(
            DiscoveryQuery::Engine(DiscoveryRequest {
                engine: target.engine.clone(),
                compute_driver: target.compute_driver,
            }),
            DiscoveryObservation::Engine(engine),
        );
    }
    observations
}
