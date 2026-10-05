// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Onboarding asks the target what planning asks for the same document: its
//! queries are the SDK's `plan_queries` with a few named exclusions, plus the
//! credential checks. Each exclusion is deliberate and tested below.
use nemoclaw_authoring::discovery_queries;
use nemoclaw_sdk::{
    config::Document,
    discovery_session::{DiscoveryQuery, plan_queries},
};

fn document(path: &str) -> Document {
    Document::parse(std::fs::File::open(path).unwrap()).unwrap()
}

fn onboarding_example() -> Document {
    Document::parse(&include_bytes!("../../../examples/onboarding/openclaw.yaml")[..]).unwrap()
}

fn credentials(document: &Document) -> Vec<DiscoveryQuery> {
    document
        .credential_names()
        .into_iter()
        .map(|reference| DiscoveryQuery::Credential {
            reference: reference.into(),
        })
        .collect()
}

#[test]
fn a_managed_gateway_with_a_hosted_route_asks_what_plan_asks_and_checks_credentials() {
    let document = onboarding_example();
    let mut expected = plan_queries(&document).unwrap();
    expected.extend(credentials(&document));
    assert_eq!(discovery_queries(&document, None).unwrap(), expected);
    assert!(!credentials(&document).is_empty());
}

#[test]
fn an_external_gateway_reads_only_its_image_store_like_plan() {
    let mut document = onboarding_example();
    document.spec.gateway = serde_json::from_value(serde_json::json!({
        "management": "external",
        "endpoint": "https://gateway.example:8080",
        "engine": "ssh://images@example.com",
    }))
    .unwrap();
    let mut expected = plan_queries(&document).unwrap();
    expected.extend(credentials(&document));
    assert_eq!(discovery_queries(&document, None).unwrap(), expected);
    assert!(expected.iter().all(|query| !matches!(
        query,
        DiscoveryQuery::Hardware { .. } | DiscoveryQuery::Engine(_)
    )));
}

#[test]
fn only_the_selected_routes_model_catalog_is_read() {
    let document = document("../../examples/spark/local-and-hosted.yaml");
    let inference = |route| {
        discovery_queries(&document, Some(route))
            .unwrap()
            .into_iter()
            .filter(|query| matches!(query, DiscoveryQuery::Inference(_)))
            .count()
    };
    // The hosted route has an external catalog; the local route is a managed
    // service, whose owner checks readiness, so neither plan nor onboarding reads it.
    assert_eq!(inference("hosted"), 1);
    assert_eq!(inference("local"), 0);
}

/// Plan also reads the hardware of each managed service's engine. Onboarding
/// reads hardware only for the gateway's engine, until a decision consumes the
/// rest.
#[test]
fn hardware_of_service_engines_is_the_first_named_exclusion() {
    let document = document("../../examples/spark/remote-vllm.yaml");
    let hardware = |queries: &[DiscoveryQuery]| {
        queries
            .iter()
            .filter(|query| matches!(query, DiscoveryQuery::Hardware { .. }))
            .count()
    };
    assert_eq!(hardware(&plan_queries(&document).unwrap()), 1);
    assert_eq!(hardware(&discovery_queries(&document, None).unwrap()), 0);
}

/// An external gateway with no engine has nowhere to read its image from. Plan
/// still compiles the read, with an empty engine, so that it can fail with
/// "set spec.gateway.engine". Onboarding makes no read, because it never
/// targets a local daemon for an unresolved engine, and reports the missing
/// engine itself.
#[test]
fn an_unresolved_engine_is_the_second_named_exclusion() {
    let document = document("../../examples/spark/remote-vllm.yaml");
    let image_reads = |queries: &[DiscoveryQuery]| {
        queries
            .iter()
            .filter(|query| matches!(query, DiscoveryQuery::Fabric { .. }))
            .count()
    };
    assert_eq!(image_reads(&plan_queries(&document).unwrap()), 1);
    assert_eq!(image_reads(&discovery_queries(&document, None).unwrap()), 0);
}
