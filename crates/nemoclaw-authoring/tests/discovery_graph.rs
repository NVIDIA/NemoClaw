// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, CompatibilityStatus, DiscoveryEvidence, DiscoveryQuery, JourneyDefinition,
    PartialDocument, discovery_key_for_document,
};
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, HarnessKind},
    discovery::{EngineObservation, FabricObservation, ObservationStatus},
    fabric_catalog::FabricCatalog,
};

fn document() -> Document {
    Document::parse(&include_bytes!("../../../examples/onboarding/openclaw.yaml")[..]).unwrap()
}

fn evidence(document: &Document) -> DiscoveryEvidence {
    DiscoveryEvidence {
        key: discovery_key_for_document(document).unwrap(),
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
            catalog: Some(FabricCatalog::bundled()),
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
    let observed = evidence(&document);
    let assessment = observed.assessment_for_document(&document).unwrap();
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
    let assessment = observed.assessment_for_document(&document).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(
        assessment
            .reasons
            .iter()
            .any(|reason| reason.contains("fabric_plan"))
    );
    observed.fabric.as_mut().unwrap().status = ObservationStatus::Unavailable;
    assert_eq!(
        observed.assessment_for_document(&document).unwrap().status,
        CompatibilityStatus::Unverified
    );
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unknown;
    observed.fabric = None;
    let assessment = observed.assessment_for_document(&document).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert!(
        assessment.pending.is_empty(),
        "do not continually retry a completed unknown engine query"
    );
}

#[test]
fn changing_the_target_discards_old_conflicts_and_queries_engine_before_fabric() {
    let document = document();
    let mut observed = evidence(&document);
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unavailable;
    assert_eq!(
        observed.assessment_for_document(&document).unwrap().status,
        CompatibilityStatus::Conflict
    );
    observed.key.engine = "unix:///another-target.sock".into();
    let assessment = observed.assessment_for_document(&document).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Engine]);
}

#[test]
fn changing_only_image_preserves_engine_evidence_and_queries_fabric() {
    let document = document();
    let mut observed = evidence(&document);
    observed.key.image = "another-image".into();
    let assessment = observed.assessment_for_document(&document).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Fabric]);
}

#[test]
fn identity_edits_preserve_evidence_and_runtime_edits_recheck_engine() {
    let capabilities = Capabilities::available();
    let original = document();
    let observed = evidence(&original);
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
        observed.assessment_for_document(&renamed).unwrap().status,
        CompatibilityStatus::Compatible
    );
    let mut changed_driver = observed.clone();
    changed_driver.key.compute_driver = ComputeDriver::Podman;
    assert_eq!(
        changed_driver
            .assessment_for_document(&renamed)
            .unwrap()
            .pending,
        vec![DiscoveryQuery::Engine]
    );
}

#[test]
fn harness_change_rechecks_the_catalog_without_invalidating_image_observation() {
    let document = document();
    let mut observed = evidence(&document);
    observed.key.harness = "nvidia.fabric.hermes".parse::<HarnessKind>().unwrap();
    observed
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap()
        .adapters
        .retain(|adapter| adapter.descriptor["adapter_id"] == "nvidia.fabric.hermes");
    let assessment = observed.assessment_for_document(&document).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(assessment.pending.is_empty());
}

#[test]
fn retarget_preserves_unaffected_observations_and_invalidates_their_dependents() {
    let document = document();
    let mut observed = evidence(&document);
    let mut key = observed.key.clone();
    key.harness = "nvidia.fabric.hermes".parse::<HarnessKind>().unwrap();
    observed.retarget(key.clone());
    assert!(observed.engine.is_some());
    assert!(observed.fabric.is_some());
    key.compute_driver = ComputeDriver::Podman;
    observed.retarget(key.clone());
    assert!(observed.engine.is_none());
    assert!(observed.fabric.is_some());
    key.engine = "unix:///other.sock".into();
    observed.retarget(key);
    assert!(observed.engine.is_none());
    assert!(observed.fabric.is_none());
}

#[test]
fn native_configuration_is_checked_by_the_fabric_planner() {
    let valid = document();
    assert_eq!(
        evidence(&valid)
            .assessment_for_document(&valid)
            .unwrap()
            .status,
        CompatibilityStatus::Compatible
    );
    let mut document = valid.clone();
    document.spec.sandboxes[0]
        .harness
        .as_mut()
        .unwrap()
        .settings =
        Some(serde_json::from_value(serde_json::json!({"not_in_the_owner_schema": true})).unwrap());
    let observed = evidence(&document);
    let assessment = observed.assessment_for_document(&document).unwrap();
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
        observed.assessment_for_document(&document).unwrap().status,
        CompatibilityStatus::Conflict
    );
    observed.fabric.as_mut().unwrap().image.architecture = None;
    assert_eq!(
        observed.assessment_for_document(&document).unwrap().status,
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
        observed.assessment_for_document(&document).unwrap().status,
        CompatibilityStatus::Conflict
    );
}
