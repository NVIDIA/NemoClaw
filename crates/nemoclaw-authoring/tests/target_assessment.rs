// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    Capabilities, CompatibilityStatus, DiscoveryAssessment, JourneyDefinition, PartialDocument,
    assess_target,
};
use nemoclaw_sdk::discovery::DiscoveryObservations;
use nemoclaw_sdk::{
    config::{ComputeDriver, Document, Gateway},
    discovery::{
        DiscoveryObservation, DiscoveryQuery, DiscoveryRequest, EngineObservation,
        FabricObservation, ObservationStatus,
    },
    fabric_capabilities::Support,
};

/// Whether any reason the assessment gives contains `text`.
fn says(assessment: &DiscoveryAssessment, text: &str) -> bool {
    assessment
        .reasons
        .iter()
        .any(|reason| reason.contains(text))
}

/// Fail with the reasons the assessment actually gave, not just "false".
#[track_caller]
fn assert_says(assessment: &DiscoveryAssessment, text: &str) {
    assert!(
        says(assessment, text),
        "expected a reason containing {text:?}, got {:?}",
        assessment.reasons
    );
}

#[track_caller]
fn assert_silent(assessment: &DiscoveryAssessment, text: &str) {
    assert!(
        !says(assessment, text),
        "expected no reason containing {text:?}, got {:?}",
        assessment.reasons
    );
}

fn document() -> Document {
    Document::parse(&include_bytes!("../../../examples/onboarding/openclaw.yaml")[..]).unwrap()
}

/// The queries that read a document's engine and its sandbox image.
fn engine_query(document: &Document) -> DiscoveryQuery {
    let key = crate::support::target(document);
    DiscoveryQuery::Engine(DiscoveryRequest {
        engine: key.engine,
        compute_driver: key.compute_driver,
    })
}

fn fabric_query(document: &Document) -> DiscoveryQuery {
    crate::support::image_query(document)
}

/// What reading a document's target returned. The observations it produces are
/// recorded under that document's own engine, driver, and image, as a journey's
/// observations are after reading it.
#[derive(Clone)]
struct Observed {
    engine: Option<EngineObservation>,
    fabric: Option<FabricObservation>,
}

impl Observed {
    fn observations(&self, document: &Document) -> DiscoveryObservations {
        crate::support::target_observations(document, self.engine.clone(), self.fabric.clone())
    }

    fn assess(&self, document: &Document) -> DiscoveryAssessment {
        assess_target(document, &self.observations(document)).unwrap()
    }
}

/// A target whose engine is available and whose image carries an installed catalog.
fn observed_target(document: &Document) -> Observed {
    Observed {
        engine: Some(crate::support::available_engine()),
        fabric: Some(crate::support::installed_image(document)),
    }
}

#[test]
fn available_engine_and_owner_valid_configuration_establish_compatibility() {
    let document = document();
    let before = document.yaml().unwrap();
    let assessment = observed_target(&document).assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Compatible);
    assert_eq!(document.yaml().unwrap(), before);
}

/// The provider's verdict on the observed image, as the plan relays it.
fn judged_as(observed: &mut Observed, status: Support, checks: &[(&str, Support, &str)]) {
    observed.fabric.as_mut().unwrap().compatibility = Some(crate::support::verdict(status, checks));
}

#[test]
fn an_unsupported_check_is_a_conflict_that_gives_its_reason() {
    let document = document();
    let mut observed = observed_target(&document);
    judged_as(
        &mut observed,
        Support::Unsupported,
        &[
            ("fabric_plan", Support::Supported, "the plan is valid"),
            (
                "image_platform",
                Support::Unsupported,
                "image is amd64, engine is arm64",
            ),
        ],
    );
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert_says(
        &assessment,
        "image_platform: image is amd64, engine is arm64.",
    );
    assert_silent(&assessment, "fabric_plan");
}

#[test]
fn an_unknown_check_leaves_the_target_unverified_and_gives_its_reason() {
    let document = document();
    let mut observed = observed_target(&document);
    judged_as(
        &mut observed,
        Support::Unknown,
        &[("bridge_interface", Support::Unknown, "no bridge advertised")],
    );
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_says(&assessment, "bridge_interface: no bridge advertised.");
}

#[test]
fn an_unsupported_check_wins_over_an_unknown_one() {
    let document = document();
    let mut observed = observed_target(&document);
    judged_as(
        &mut observed,
        Support::Unsupported,
        &[
            ("fabric_catalog", Support::Unknown, "no catalog"),
            ("image_platform", Support::Unsupported, "wrong architecture"),
        ],
    );
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Conflict);
    assert_says(&assessment, "fabric_catalog: no catalog.");
    assert_says(&assessment, "image_platform: wrong architecture.");
}

#[test]
fn a_verdict_on_an_image_without_an_id_is_ignored() {
    let document = document();
    let mut observed = observed_target(&document);
    judged_as(
        &mut observed,
        Support::Unsupported,
        &[("image_platform", Support::Unsupported, "wrong architecture")],
    );
    observed.fabric.as_mut().unwrap().image_id = None;
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_silent(&assessment, "wrong architecture");
}

#[test]
fn an_image_that_is_not_present_is_unverified_rather_than_a_conflict() {
    let document = document();
    let mut observed = observed_target(&document);
    judged_as(
        &mut observed,
        Support::Unsupported,
        &[("image_platform", Support::Unsupported, "wrong architecture")],
    );
    observed.fabric.as_mut().unwrap().status = ObservationStatus::Unavailable;
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_says(&assessment, "image is not present");
    assert_silent(&assessment, "wrong architecture");
}

#[test]
fn an_unknown_engine_leaves_the_target_unverified_and_says_so() {
    let document = document();
    let mut observed = observed_target(&document);
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unknown;
    observed.fabric = None;
    let assessment = observed.assess(&document);
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    // A failed read is unknown, not unasked.
    assert_says(&assessment, "The selected engine remains unverified");
    assert_silent(&assessment, "The selected engine has not been observed");
}

#[test]
fn a_read_that_failed_is_unknown_so_unverified_rather_than_unobserved() {
    let document = document();
    let (engine, fabric) = (engine_query(&document), fabric_query(&document));
    let observations = DiscoveryObservations::new()
        .with(
            engine,
            DiscoveryObservation::Engine(EngineObservation::unknown("engine unreachable")),
        )
        .with(
            fabric,
            DiscoveryObservation::Fabric(FabricObservation::unknown("image unreadable")),
        );
    let assessment = assess_target(&document, &observations).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_says(&assessment, "The selected engine remains unverified");
    assert_says(&assessment, "Fabric capabilities remain unverified");
    assert_silent(&assessment, "not been observed");
}

/// Editing one part of the target leaves the observations recorded for the
/// others in place and the edited part unobserved.
#[test]
fn editing_the_target_leaves_only_the_edited_observation_unfound() {
    struct Row {
        edit: &'static str,
        before: Document,
        /// An external gateway's engine is never probed, so it has no engine observation.
        engine_observed: bool,
        change: fn(&mut Document),
        engine_unobserved: bool,
        image_unobserved: bool,
    }
    const ENGINE: &str = "The selected engine has not been observed";
    const IMAGE: &str = "Fabric capabilities have not been observed";
    let external = || external_document("ssh://images@example.com");
    let rows = [
        Row {
            edit: "gateway engine",
            before: document(),
            engine_observed: true,
            change: |document| {
                let Gateway::Managed(gateway) = &mut document.spec.gateway else {
                    panic!("the example uses a managed gateway")
                };
                gateway.engine = "unix:///another-target.sock".into();
            },
            engine_unobserved: true,
            // The image is read from the gateway's engine.
            image_unobserved: true,
        },
        Row {
            edit: "sandbox image",
            before: document(),
            engine_observed: true,
            change: |document| {
                document.spec.sandboxes[0].image.ref_ =
                    format!("another-image@sha256:{}", "0".repeat(64));
            },
            engine_unobserved: false,
            image_unobserved: true,
        },
        Row {
            edit: "compute driver",
            before: document(),
            engine_observed: true,
            change: |document| {
                document.spec.gateway.runtime_mut().provider = ComputeDriver::Podman;
            },
            engine_unobserved: true,
            // The image is read through the same driver.
            image_unobserved: true,
        },
        Row {
            edit: "external gateway image engine",
            before: external(),
            engine_observed: false,
            change: |document| {
                *document = external_document("ssh://different-images@example.com");
            },
            engine_unobserved: false,
            image_unobserved: true,
        },
        Row {
            edit: "external gateway switched to managed",
            before: external_document(&crate::support::target(&document()).engine),
            engine_observed: false,
            change: |document| document.spec.gateway = self::document().spec.gateway,
            engine_unobserved: true,
            // A managed gateway's image read is placed by its engine's platform.
            image_unobserved: true,
        },
    ];
    for row in rows {
        let observed = Observed {
            engine: row.engine_observed.then(crate::support::available_engine),
            ..observed_target(&row.before)
        };
        let observations = observed.observations(&row.before);
        // The unedited target is assessed from the same observations as a control.
        let control = assess_target(&row.before, &observations).unwrap();
        assert!(
            !says(&control, "has not been observed"),
            "{}: {:?}",
            row.edit,
            control.reasons
        );
        let mut edited = row.before.clone();
        (row.change)(&mut edited);
        let assessment = assess_target(&edited, &observations).unwrap();
        assert_eq!(
            assessment.status,
            CompatibilityStatus::Unverified,
            "{}: {:?}",
            row.edit,
            assessment.reasons
        );
        for (text, expected) in [
            (ENGINE, row.engine_unobserved),
            (IMAGE, row.image_unobserved),
        ] {
            assert_eq!(
                says(&assessment, text),
                expected,
                "{}: {text:?} in {:?}",
                row.edit,
                assessment.reasons
            );
        }
    }
}

#[test]
fn renaming_the_target_keeps_it_compatible() {
    let capabilities = Capabilities::available();
    let original = document();
    let observations = observed_target(&original).observations(&original);
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
        assess_target(&renamed, &observations).unwrap().status,
        CompatibilityStatus::Compatible
    );
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
    document.spec.gateway.runtime_mut().provider = ComputeDriver::Podman;
    document
}

#[test]
fn an_unobserved_external_gateway_target_is_unverified() {
    let document = external_document("ssh://images@example.com");
    assert_eq!(
        crate::support::target(&document).engine,
        "ssh://images@example.com"
    );
    let assessment = assess_target(&document, &DiscoveryObservations::new()).unwrap();
    assert_says(&assessment, "Fabric capabilities have not been observed");
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
}

#[test]
fn a_managed_gateway_engine_probe_cannot_disqualify_an_external_gateway() {
    let document = external_document("ssh://images@example.com");
    let mut observed = observed_target(&document);
    observed.engine.as_mut().unwrap().status = ObservationStatus::Unavailable;
    assert_eq!(
        observed.assess(&document).status,
        CompatibilityStatus::Compatible
    );
}

#[test]
fn external_gateway_without_an_image_engine_stays_unverified_and_names_the_missing_engine() {
    let document = external_document("");
    let assessment = assess_target(&document, &DiscoveryObservations::new()).unwrap();
    assert_eq!(assessment.status, CompatibilityStatus::Unverified);
    assert_says(&assessment, "spec.gateway.engine");
}
