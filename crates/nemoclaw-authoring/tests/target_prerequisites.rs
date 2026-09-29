// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    AuthoringFacts, Capabilities, CompatibilityStatus, DiscoveryEvidence, EndpointEvidence,
    JourneyDefinition, JourneyScope, PartialDocument, TargetPrerequisite,
    discovery_key_for_document, inference_request_for_document,
};
use nemoclaw_sdk::{
    discovery::{EngineObservation, FabricObservation, ObservationStatus},
    fabric_capabilities::ImageMetadata,
    fabric_catalog::FabricCatalog,
    inference_discovery::{AuthenticationStatus, EndpointObservation},
};
use serde_json::json;

fn express() -> JourneyDefinition {
    let base =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))
            .unwrap();
    JourneyDefinition::new("express", base).omit([
        "adapter:nvidia.fabric.openclaw:/agent_name",
        "adapter:nvidia.fabric.openclaw:/cli",
        "adapter:nvidia.fabric.openclaw:/home",
        "adapter:nvidia.fabric.openclaw:/native_config",
        "adapter:nvidia.fabric.openclaw:/timeout_seconds",
    ])
}

#[test]
fn required_target_compatibility_stays_unverified_without_current_evidence() {
    let capabilities = Capabilities::available();
    let ordinary = express().start(&capabilities).unwrap();
    assert!(
        ordinary
            .resolve(&capabilities)
            .unwrap()
            .ready_document()
            .is_some()
    );

    let definition = express().require_target([TargetPrerequisite::EngineAndImageCompatible]);
    let tree = definition.print_tree(&capabilities).unwrap();
    assert!(tree.contains("Target prerequisite: Unverified"), "{tree}");
    let state = definition.start(&capabilities).unwrap();
    let unresolved = state.resolve(&capabilities).unwrap();
    assert!(unresolved.materialized_document().is_some());
    assert!(unresolved.ready_document().is_none());
    assert_eq!(
        unresolved.target_assessment().unwrap().status,
        CompatibilityStatus::Unverified
    );

    let document = unresolved.materialized_document().unwrap();
    let key = discovery_key_for_document(document).unwrap();
    let compatible = DiscoveryEvidence {
        key: key.clone(),
        engine: Some(EngineObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            server_version: Some("1".into()),
            architecture: Some("aarch64".into()),
            operating_system: Some("linux".into()),
            memory_bytes: None,
            cpus: None,
        }),
        fabric: Some(FabricObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            image_id: Some("sha256:observed".into()),
            catalog: Some(FabricCatalog::bundled()),
            image: ImageMetadata {
                architecture: Some("arm64".into()),
                operating_system: Some("linux".into()),
                repo_digests: vec![key.image],
                ..Default::default()
            },
            compatibility: None,
        }),
    };
    let verified = state
        .resolve_with_evidence(&capabilities, &AuthoringFacts::default(), Some(&compatible))
        .unwrap();
    assert_eq!(
        verified.target_assessment().unwrap().status,
        CompatibilityStatus::Compatible
    );
    assert!(verified.ready_document().is_some());

    let mut stale = compatible;
    stale.key.image = "sha256:old-image".into();
    let unresolved = state
        .resolve_with_evidence(&capabilities, &AuthoringFacts::default(), Some(&stale))
        .unwrap();
    assert_eq!(
        unresolved.target_assessment().unwrap().status,
        CompatibilityStatus::Unverified
    );
    assert!(unresolved.ready_document().is_none());
}

#[test]
fn observed_target_conflict_blocks_ready_document_without_an_explicit_prerequisite() {
    let capabilities = Capabilities::available();
    let state = express().start(&capabilities).unwrap();
    let plain = state.resolve(&capabilities).unwrap();
    let document = plain.materialized_document().unwrap();
    assert!(plain.ready_document().is_some());
    let conflict = DiscoveryEvidence {
        key: discovery_key_for_document(document).unwrap(),
        engine: Some(EngineObservation {
            status: ObservationStatus::Unavailable,
            reason: Some("engine rejected the target".into()),
            source: "fixture".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }),
        fabric: None,
    };
    let resolved = state
        .resolve_with_evidence(&capabilities, &AuthoringFacts::default(), Some(&conflict))
        .unwrap();
    assert_eq!(
        resolved.target_assessment().unwrap().status,
        CompatibilityStatus::Conflict
    );
    assert!(resolved.materialized_document().is_some());
    assert!(resolved.ready_document().is_none());
}

#[test]
fn one_resolution_combines_model_suggestions_and_target_compatibility() {
    let capabilities = Capabilities::available();
    let state = express()
        .ask([JourneyScope::RouteModels])
        .start(&capabilities)
        .unwrap();
    let base = state.resolve(&capabilities).unwrap();
    let document = base.assessment().document().unwrap();
    let facts = AuthoringFacts {
        endpoint: Some(EndpointEvidence {
            request: inference_request_for_document(document, state.current_route()).unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "fixture".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec!["vendor/discovered-model".into()],
                api_verified: false,
            },
        }),
        ..Default::default()
    };
    let conflict = DiscoveryEvidence {
        key: discovery_key_for_document(document).unwrap(),
        engine: Some(EngineObservation {
            status: ObservationStatus::Unavailable,
            reason: Some("engine rejected the target".into()),
            source: "fixture".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }),
        fabric: None,
    };
    let resolved = state
        .resolve_with_evidence(&capabilities, &facts, Some(&conflict))
        .unwrap();
    let model = "/spec/sandboxes/0/agent/inference/routes/0/overrides/model";
    assert!(
        resolved
            .question(model)
            .unwrap()
            .choices()
            .contains(&json!("vendor/discovered-model"))
    );
    assert_eq!(
        resolved.target_assessment().unwrap().status,
        CompatibilityStatus::Conflict
    );
    assert!(resolved.ready_document().is_none());
}
