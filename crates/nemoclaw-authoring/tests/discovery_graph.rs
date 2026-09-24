// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Answers, Capabilities, CompatibilityStatus, DiscoveryEvidence, DiscoveryQuery, Draft,
    EditableField, FieldValue, Session,
};
use nemoclaw_sdk::{
    config::{ComputeDriver, HarnessKind},
    discovery::{EngineObservation, FabricObservation, ObservationStatus},
    fabric_catalog::FabricCatalog,
};

fn draft() -> Draft {
    let authored = Session::new()
        .unwrap()
        .project(&Capabilities::available(), &Answers::onboarding_defaults())
        .unwrap();
    Draft::from_document(authored.document().clone()).unwrap()
}

fn evidence(draft: &Draft) -> DiscoveryEvidence {
    DiscoveryEvidence {
        key: draft.discovery_key().unwrap(),
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
        }),
    }
}

#[test]
fn available_engine_and_selected_adapter_establish_compatibility_without_changing_choices() {
    let draft = draft();
    let observed = evidence(&draft);
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Compatible);
    assert!(assessment.pending.is_empty());
    assert_eq!(
        draft.guided_fields(&Capabilities::available()).unwrap()[0]
            .choices()
            .len(),
        4
    );
}

#[test]
fn confirmed_missing_adapter_is_a_conflict_but_missing_image_and_unknown_engine_are_unverified() {
    let draft = draft();
    let mut observed = evidence(&draft);
    observed
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap()
        .adapters
        .retain(|adapter| adapter.harness != "openclaw");
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(
        assessment
            .reasons
            .iter()
            .any(|reason| reason.contains("openclaw"))
    );
    observed.fabric.as_mut().unwrap().status = ObservationStatus::Unavailable;
    assert_eq!(
        observed.assessment(&draft).unwrap().status,
        CompatibilityStatus::Unverified
    );
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unknown;
    observed.fabric = None;
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert!(
        assessment.pending.is_empty(),
        "do not continually retry a completed unknown engine query"
    );
}

#[test]
fn changing_the_target_discards_old_conflicts_and_queries_engine_before_fabric() {
    let draft = draft();
    let mut observed = evidence(&draft);
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unavailable;
    assert_eq!(
        observed.assessment(&draft).unwrap().status,
        CompatibilityStatus::Conflict
    );
    observed.key.engine = "unix:///another-target.sock".into();
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Engine]);
}

#[test]
fn changing_only_image_preserves_engine_evidence_and_queries_fabric() {
    let draft = draft();
    let mut observed = evidence(&draft);
    observed.key.image = "another-image".into();
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Fabric]);
}

#[test]
fn identity_edits_preserve_evidence_and_runtime_edits_recheck_engine() {
    let capabilities = Capabilities::available();
    let original = draft();
    let observed = evidence(&original);
    let renamed = original
        .propose_guided_edit(
            &capabilities,
            EditableField::DeploymentName,
            FieldValue::Text("renamed".into()),
        )
        .unwrap()
        .accept();
    assert_eq!(
        observed.assessment(&renamed).unwrap().status,
        CompatibilityStatus::Compatible
    );
    let mut changed_driver = observed.clone();
    changed_driver.key.compute_driver = ComputeDriver::Podman;
    assert_eq!(
        changed_driver.assessment(&renamed).unwrap().pending,
        vec![DiscoveryQuery::Engine]
    );
}

#[test]
fn harness_change_rechecks_the_catalog_without_invalidating_image_observation() {
    let draft = draft();
    let mut observed = evidence(&draft);
    observed.key.harness = HarnessKind::Hermes;
    observed
        .fabric
        .as_mut()
        .unwrap()
        .catalog
        .as_mut()
        .unwrap()
        .adapters
        .retain(|adapter| adapter.harness == "hermes");
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(assessment.pending.is_empty());
}

#[test]
fn retarget_preserves_unaffected_observations_and_invalidates_their_dependents() {
    let draft = draft();
    let mut observed = evidence(&draft);
    let mut key = observed.key.clone();
    key.harness = HarnessKind::Hermes;
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
