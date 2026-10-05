// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, CompatibilityStatus, JourneyDefinition, JourneyScope, PartialDocument,
    TargetPrerequisite, inference_request_for_document,
};
use nemoclaw_sdk::{
    discovery::ObservationStatus,
    discovery_session::{DiscoveryObservation, DiscoveryQuery},
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
fn required_target_compatibility_stays_unverified_without_current_observations() {
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
    let engine = crate::support::available_engine();
    let fabric = crate::support::installed_image(document);
    let compatible =
        crate::support::target_observations(document, Some(engine.clone()), Some(fabric.clone()));
    let verified = state
        .resolve_with_observations(&capabilities, &compatible)
        .unwrap();
    assert_eq!(
        verified.target_assessment().unwrap().status,
        CompatibilityStatus::Compatible
    );
    assert!(verified.ready_document().is_some());

    // Observations read for another image say nothing about this one.
    let mut other_image = document.clone();
    other_image.spec.sandboxes[0].image.ref_ = format!("old-image@sha256:{}", "0".repeat(64));
    let stale = crate::support::target_observations(&other_image, Some(engine), Some(fabric));
    let unresolved = state
        .resolve_with_observations(&capabilities, &stale)
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
    let conflict = crate::support::target_observations(
        document,
        Some(crate::support::rejecting_engine()),
        None,
    );
    let resolved = state
        .resolve_with_observations(&capabilities, &conflict)
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
    let mut observations = crate::support::target_observations(
        document,
        Some(crate::support::rejecting_engine()),
        None,
    );
    observations.record(
        DiscoveryQuery::Inference(
            inference_request_for_document(document, state.current_route())
                .unwrap()
                .unwrap(),
        ),
        DiscoveryObservation::Inference(EndpointObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            reachable: Some(true),
            authentication: AuthenticationStatus::Accepted,
            models: vec!["vendor/discovered-model".into()],
            api_verified: false,
        }),
    );
    let resolved = state
        .resolve_with_observations(&capabilities, &observations)
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
