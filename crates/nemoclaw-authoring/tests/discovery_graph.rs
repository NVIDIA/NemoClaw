// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Answers, Capabilities, CompatibilityStatus, DiscoveryEvidence, DiscoveryQuery, Draft,
    EditableField, FieldValue, Session,
};
use nemoclaw_sdk::{
    config::{ComputeDriver, HarnessKind},
    discovery::{EngineObservation, FabricObservation, ObservationStatus},
    fabric_catalog::{BridgeCapabilities, FabricCatalog},
};

fn draft() -> Draft {
    let authored = Session::new()
        .unwrap()
        .project(&Capabilities::available(), &Answers::onboarding_defaults())
        .unwrap();
    Draft::from_document(authored.document().clone()).unwrap()
}

fn evidence(draft: &Draft) -> DiscoveryEvidence {
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
            catalog: Some(catalog),
            image: nemoclaw_sdk::fabric_capabilities::ImageMetadata {
                architecture: Some("arm64".into()),
                operating_system: Some("linux".into()),
                repo_digests: vec![draft.discovery_key().unwrap().image],
                ..Default::default()
            },
            compatibility: None,
        }),
    }
}

#[test]
fn available_engine_and_owner_valid_configuration_establish_compatibility() {
    let draft = draft();
    let choices = draft.guided_fields(&Capabilities::available()).unwrap()[0]
        .choices()
        .to_vec();
    let observed = evidence(&draft);
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Compatible);
    assert!(assessment.pending.is_empty());
    assert_eq!(
        draft.guided_fields(&Capabilities::available()).unwrap()[0].choices(),
        choices
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
        .retain(|adapter| adapter.descriptor["adapter_id"] != "nvidia.fabric.openclaw");
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(
        assessment
            .reasons
            .iter()
            .any(|reason| reason.contains("fabric_plan"))
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
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert!(assessment.pending.is_empty());
}

#[test]
fn retarget_preserves_unaffected_observations_and_invalidates_their_dependents() {
    let draft = draft();
    let mut observed = evidence(&draft);
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
    let valid = draft();
    assert_eq!(
        evidence(&valid).assessment(&valid).unwrap().status,
        CompatibilityStatus::Compatible
    );
    let mut document = valid.document().clone();
    document.spec.sandboxes[0]
        .harness
        .as_mut()
        .unwrap()
        .settings =
        Some(serde_json::from_value(serde_json::json!({"not_in_the_owner_schema": true})).unwrap());
    let draft = Draft::from_document(document).unwrap();
    let observed = evidence(&draft);
    let assessment = observed.assessment(&draft).unwrap();
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
    let draft = draft();
    let mut observed = evidence(&draft);
    observed.fabric.as_mut().unwrap().image.architecture = Some("amd64".into());
    assert_eq!(
        observed.assessment(&draft).unwrap().status,
        CompatibilityStatus::Conflict
    );
    observed.fabric.as_mut().unwrap().image.architecture = None;
    assert_eq!(
        observed.assessment(&draft).unwrap().status,
        CompatibilityStatus::Unverified
    );
}

#[test]
fn missing_adapter_label_does_not_hide_a_proven_image_platform_mismatch() {
    let draft = draft();
    let mut observed = evidence(&draft);
    let image = observed.fabric.as_mut().unwrap();
    image.status = ObservationStatus::Unknown;
    image.catalog = None;
    image.image.architecture = Some("amd64".into());
    assert_eq!(
        observed.assessment(&draft).unwrap().status,
        CompatibilityStatus::Conflict
    );
}

fn external_draft(engine: &str) -> Draft {
    let mut document = draft().document().clone();
    document.spec.gateway = serde_json::from_value(serde_json::json!({
        "management": "external",
        "endpoint": "https://gateway.example:8080",
        "engine": engine,
    }))
    .unwrap();
    // The image store need not run the gateway's selected compute driver.
    document.spec.sandboxes[0].runtime.provider = ComputeDriver::Podman;
    Draft::from_document(document).unwrap()
}

#[test]
fn external_gateway_discovery_tracks_only_the_configured_image_engine() {
    let draft = external_draft("ssh://images@example.com");
    assert_eq!(
        draft.discovery_key().unwrap().engine,
        "ssh://images@example.com"
    );
    let observed = DiscoveryEvidence {
        key: draft.discovery_key().unwrap(),
        engine: None,
        fabric: None,
    };
    let assessment = observed.assessment(&draft).unwrap();
    assert_eq!(assessment.pending, vec![DiscoveryQuery::Fabric]);
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);

    let mut observed = evidence(&draft);
    // A managed-gateway probe against the image store cannot disqualify an
    // external gateway, or supply its execution platform.
    let engine = observed.engine.as_mut().unwrap();
    engine.status = ObservationStatus::Unavailable;
    engine.architecture = Some("amd64".into());
    assert_eq!(
        observed.assessment(&draft).unwrap().status,
        CompatibilityStatus::Compatible
    );

    let changed = external_draft("ssh://different-images@example.com");
    assert_eq!(
        observed.assessment(&changed).unwrap().pending,
        vec![DiscoveryQuery::Fabric]
    );
    observed.retarget(changed.discovery_key().unwrap());
    assert!(observed.engine.is_none());
    assert!(observed.fabric.is_none());
}

#[test]
fn external_gateway_without_an_image_engine_stays_unverified_without_a_query() {
    let draft = external_draft("");
    let observed = DiscoveryEvidence {
        key: draft.discovery_key().unwrap(),
        engine: None,
        fabric: None,
    };
    let assessment = observed.assessment(&draft).unwrap();
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
fn changing_gateway_management_rechecks_engine_but_retains_image_metadata() {
    let managed = draft();
    let mut document = managed.document().clone();
    document.spec.gateway = serde_json::from_value(serde_json::json!({
        "management": "external",
        "endpoint": "https://gateway.example:8080",
        "engine": managed.discovery_key().unwrap().engine,
    }))
    .unwrap();
    let external = Draft::from_document(document).unwrap();
    let mut facts = nemoclaw_authoring::AuthoringFacts {
        hardware: Some(nemoclaw_authoring::HardwareEvidence {
            engine: managed.discovery_key().unwrap().engine,
            observation: nemoclaw_sdk::hardware_discovery::HardwareObservation::unknown(),
        }),
        ..Default::default()
    };
    facts
        .retarget(&external, &Capabilities::available())
        .unwrap();
    assert!(
        facts.hardware.is_none(),
        "image-store hardware is not gateway evidence"
    );
    let mut observed = evidence(&external);
    assert_eq!(
        observed.assessment(&managed).unwrap().pending,
        vec![DiscoveryQuery::Engine]
    );
    observed.retarget(managed.discovery_key().unwrap());
    assert!(observed.engine.is_none());
    assert!(observed.fabric.is_some());
}
