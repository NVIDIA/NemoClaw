// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, CompatibilityStatus, DiscoveryAssessment, DiscoveryQuery, JourneyDefinition,
    PartialDocument, assess_target, discovery_key_for_document, inference_request_for_document,
};
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, Gateway, InferenceApi, InferenceProviderKind},
    discovery::{DiscoveryRequest, EngineObservation, FabricObservation, ObservationStatus},
    fabric_catalog::{BridgeCapabilities, FabricCatalog},
    facts::{Fact, FactQuery, FactSheet},
};

fn document() -> Document {
    Document::parse(&include_bytes!("../../../examples/onboarding/openclaw.yaml")[..]).unwrap()
}

/// What reading a document's target returned. The sheet it produces holds the
/// observations under that document's own engine, driver, and image, as a
/// journey's sheet does after reading it.
#[derive(Clone)]
struct Observed {
    engine: Option<EngineObservation>,
    fabric: Option<FabricObservation>,
}

impl Observed {
    fn sheet(&self, document: &Document) -> FactSheet {
        let key = discovery_key_for_document(document).unwrap();
        let mut sheet = FactSheet::new();
        if let Some(engine) = &self.engine {
            sheet.record(
                FactQuery::Engine(DiscoveryRequest {
                    engine: key.engine.clone(),
                    compute_driver: key.compute_driver,
                }),
                Some(Fact::Engine(engine.clone())),
            );
        }
        if let Some(fabric) = &self.fabric {
            sheet.record(
                FactQuery::Fabric {
                    engine: key.engine,
                    image: key.image,
                },
                Some(Fact::Fabric(fabric.clone())),
            );
        }
        sheet
    }

    fn assess(&self, document: &Document) -> DiscoveryAssessment {
        assess_target(document, &self.sheet(document)).unwrap()
    }
}

fn evidence(document: &Document) -> Observed {
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
    Observed {
        engine: Some(EngineObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "engine_gateway_prerequisites".into(),
            server_version: Some("1".into()),
            architecture: Some("aarch64".into()),
            operating_system: Some("linux".into()),
            memory_bytes: None,
            cpus: None,
        }),
        fabric: Some(FabricObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "engine_image_inspect".into(),
            image_id: Some("sha256:observed".into()),
            catalog: Some(catalog),
            image: nemoclaw_sdk::fabric_capabilities::ImageMetadata {
                architecture: Some("arm64".into()),
                operating_system: Some("linux".into()),
                repo_digests: vec![discovery_key_for_document(document).unwrap().image],
                ..Default::default()
            },
            compatibility: None,
        }),
    }
}

#[test]
fn available_engine_and_owner_valid_configuration_establish_compatibility() {
    let document = document();
    let before = document.yaml().unwrap();
    let assessment = evidence(&document).assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Compatible);
    assert!(assessment.pending.is_empty());
    assert_eq!(document.yaml().unwrap(), before);
}

#[test]
fn confirmed_missing_adapter_is_a_conflict_but_missing_image_and_unknown_engine_are_unverified() {
    let document = document();
    let mut observed = evidence(&document);
    observed
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap()
        .adapters
        .retain(|adapter| adapter.descriptor["adapter_id"] != "nvidia.fabric.openclaw");
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(
        assessment
            .reasons
            .iter()
            .any(|reason| reason.contains("fabric_plan"))
    );
    observed.fabric.as_mut().unwrap().status = ObservationStatus::Unavailable;
    assert_eq!(
        observed.assess(&document).status,
        CompatibilityStatus::Unverified
    );
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unknown;
    observed.fabric = None;
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert!(
        assessment.pending.is_empty(),
        "do not continually retry a completed unknown engine query"
    );
}

#[test]
fn a_read_that_observed_nothing_is_unverified_and_not_asked_again() {
    let document = document();
    let key = discovery_key_for_document(&document).unwrap();
    let sheet = FactSheet::new()
        .with(
            FactQuery::Engine(DiscoveryRequest {
                engine: key.engine.clone(),
                compute_driver: key.compute_driver,
            }),
            None,
        )
        .with(
            FactQuery::Fabric {
                engine: key.engine,
                image: key.image,
            },
            None,
        );
    let assessment = assess_target(&document, &sheet).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert!(assessment.pending.is_empty());
}

#[test]
fn changing_the_target_leaves_old_facts_behind_and_queries_engine_before_fabric() {
    let document = document();
    let mut observed = evidence(&document);
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unavailable;
    assert_eq!(
        observed.assess(&document).status,
        CompatibilityStatus::Conflict
    );
    let sheet = observed.sheet(&document);
    let mut moved = document.clone();
    let Gateway::Managed(gateway) = &mut moved.spec.gateway else {
        panic!("the example uses a managed gateway")
    };
    gateway.engine = "unix:///another-target.sock".into();
    let assessment = assess_target(&moved, &sheet).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Engine]);
}

#[test]
fn changing_only_image_keeps_engine_facts_and_queries_fabric() {
    let document = document();
    let sheet = evidence(&document).sheet(&document);
    let mut changed = document.clone();
    changed.spec.sandboxes[0].image.ref_ = "another-image".into();
    let assessment = assess_target(&changed, &sheet).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Fabric]);
}

#[test]
fn identity_edits_keep_facts_and_runtime_edits_recheck_engine() {
    let capabilities = Capabilities::available();
    let original = document();
    let sheet = evidence(&original).sheet(&original);
    let base = PartialDocument::from_yaml(original.yaml().unwrap().as_bytes()).unwrap();
    let mut state = JourneyDefinition::new("rename", base)
        .ask(["/metadata/name"])
        .start(&capabilities)
        .unwrap();
    state
        .answer(
            &capabilities,
            "/metadata/name",
            Some(serde_json::json!("renamed")),
        )
        .unwrap();
    let renamed = state
        .resolve(&capabilities)
        .unwrap()
        .assessment()
        .document()
        .unwrap()
        .clone();
    assert_eq!(
        assess_target(&renamed, &sheet).unwrap().status,
        CompatibilityStatus::Compatible
    );
    let mut changed_driver = renamed.clone();
    changed_driver.spec.sandboxes[0].runtime.provider = ComputeDriver::Podman;
    assert_eq!(
        assess_target(&changed_driver, &sheet).unwrap().pending,
        vec![DiscoveryQuery::Engine]
    );
}

#[test]
fn a_catalog_without_the_adapter_conflicts_without_reading_the_image_again() {
    let document = document();
    let mut observed = evidence(&document);
    observed
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap()
        .adapters
        .retain(|adapter| adapter.descriptor["adapter_id"] == "nvidia.fabric.hermes");
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(assessment.pending.is_empty());
}

#[test]
fn native_configuration_is_checked_by_the_fabric_planner() {
    let valid = document();
    assert_eq!(
        evidence(&valid).assess(&valid).status,
        CompatibilityStatus::Compatible
    );
    let mut document = valid.clone();
    document.spec.sandboxes[0]
        .harness
        .as_mut()
        .unwrap()
        .settings =
        Some(serde_json::from_value(serde_json::json!({"not_in_the_owner_schema": true})).unwrap());
    let assessment = evidence(&document).assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(
        assessment
            .reasons
            .iter()
            .any(|reason| reason.contains("fabric_plan"))
    );
}

#[test]
fn image_platform_conflict_blocks_while_missing_platform_stays_unverified() {
    let document = document();
    let mut observed = evidence(&document);
    observed.fabric.as_mut().unwrap().image.architecture = Some("amd64".into());
    assert_eq!(
        observed.assess(&document).status,
        CompatibilityStatus::Conflict
    );
    observed.fabric.as_mut().unwrap().image.architecture = None;
    assert_eq!(
        observed.assess(&document).status,
        CompatibilityStatus::Unverified
    );
}

#[test]
fn missing_adapter_label_does_not_hide_a_proven_image_platform_mismatch() {
    let document = document();
    let mut observed = evidence(&document);
    let image = observed.fabric.as_mut().unwrap();
    image.status = ObservationStatus::Unknown;
    image.catalog = None;
    image.image.architecture = Some("amd64".into());
    assert_eq!(
        observed.assess(&document).status,
        CompatibilityStatus::Conflict
    );
}

#[test]
fn managed_service_route_has_no_external_catalog_to_discover() {
    let document =
        Document::parse(&include_bytes!("../../../examples/managed-ollama.yaml")[..]).unwrap();
    let before = document.clone();
    assert_eq!(
        inference_request_for_document(&document, None).unwrap(),
        None
    );
    assert_eq!(document, before);
}

#[test]
fn provider_without_an_explicit_api_is_probed_with_its_protocol_default() {
    let mut document = document();
    let provider = document.inference_provider_mut().unwrap();
    provider.provider = InferenceProviderKind::Anthropic;
    provider.api = None;
    let request = inference_request_for_document(&document, None)
        .unwrap()
        .unwrap();
    assert_eq!(request.api, InferenceApi::AnthropicMessages);
}

fn external_document(engine: &str) -> Document {
    let mut document = document();
    document.spec.gateway = serde_json::from_value(serde_json::json!({
        "management": "external",
        "endpoint": "https://gateway.example:8080",
        "engine": engine,
    }))
    .unwrap();
    // The image store need not run the gateway's selected compute driver.
    document.spec.sandboxes[0].runtime.provider = ComputeDriver::Podman;
    document
}

#[test]
fn external_gateway_discovery_tracks_only_the_configured_image_engine() {
    let document = external_document("ssh://images@example.com");
    assert_eq!(
        discovery_key_for_document(&document).unwrap().engine,
        "ssh://images@example.com"
    );
    let assessment = assess_target(&document, &FactSheet::new()).unwrap();
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Fabric]);
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);

    let mut observed = evidence(&document);
    // A managed-gateway probe against the image store cannot disqualify an
    // external gateway, or supply its execution platform.
    let engine = observed.engine.as_mut().unwrap();
    engine.status = ObservationStatus::Unavailable;
    engine.architecture = Some("amd64".into());
    assert_eq!(
        observed.assess(&document).status,
        CompatibilityStatus::Compatible
    );

    let changed = external_document("ssh://different-images@example.com");
    assert_eq!(
        assess_target(&changed, &observed.sheet(&document))
            .unwrap()
            .pending,
        vec![DiscoveryQuery::Fabric]
    );
}

#[test]
fn external_gateway_without_an_image_engine_stays_unverified_without_a_query() {
    let document = external_document("");
    let assessment = assess_target(&document, &FactSheet::new()).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert!(assessment.pending.is_empty());
    assert!(
        assessment
            .reasons
            .iter()
            .any(|reason| reason.contains("spec.gateway.engine"))
    );
}

#[test]
fn switching_to_a_managed_gateway_requires_an_engine_observation() {
    let managed = document();
    let mut document = managed.clone();
    document.spec.gateway = serde_json::from_value(serde_json::json!({
        "management": "external",
        "endpoint": "https://gateway.example:8080",
        "engine": discovery_key_for_document(&managed).unwrap().engine,
    }))
    .unwrap();
    let external = document;
    // An external gateway's engine is never probed, so its sheet holds only the image.
    let observed = Observed {
        engine: None,
        ..evidence(&external)
    };
    assert_eq!(
        assess_target(&managed, &observed.sheet(&external))
            .unwrap()
            .pending,
        vec![DiscoveryQuery::Engine]
    );
}
