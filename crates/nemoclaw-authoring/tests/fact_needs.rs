// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Onboarding reads the environment through the same inputs that planning
//! compiles for the same document. The SDK's plan is the reference; each
//! difference below is deliberate and named.
use nemoclaw_authoring::fact_needs;
use nemoclaw_sdk::{
    compile, config::Document, discovery::DiscoveryRequest, facts::FactQuery,
    inference_discovery::EndpointRequest,
};
use serde_json::Value;
use std::collections::BTreeSet;

/// The provider reads the SDK compiles into a plan's discovery graph.
struct PlanReads {
    endpoints: Vec<EndpointRequest>,
    engine: Option<DiscoveryRequest>,
    hardware: BTreeSet<String>,
    fabric: Vec<(String, String)>,
    gateway_drivers: Value,
}

fn plan_reads(document: &Document) -> PlanReads {
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let graph = compile::compile(document, &generations, "0.1.0").unwrap();
    let data = &graph["data"];
    let section = |name: &str| data[name].as_object().cloned().unwrap_or_default();
    let mut endpoints: Vec<EndpointRequest> = section("nemoclaw_inference_capabilities")
        .values()
        .map(|inputs| serde_json::from_value(inputs.clone()).unwrap())
        .collect();
    endpoints.sort_by_key(|request| request.endpoint.clone());
    PlanReads {
        endpoints,
        engine: data["nemoclaw_engine_capabilities"]
            .get("current")
            .map(|inputs| serde_json::from_value(inputs.clone()).unwrap()),
        hardware: section("nemoclaw_target_hardware")
            .values()
            .map(|inputs| inputs["engine"].as_str().unwrap().into())
            .collect(),
        fabric: section("nemoclaw_fabric_capabilities")
            .values()
            .map(|inputs| {
                (
                    inputs["engine"].as_str().unwrap().into(),
                    inputs["image"].as_str().unwrap().into(),
                )
            })
            .collect(),
        gateway_drivers:
            data["nemoclaw_gateway_capabilities"]["current"]["required_compute_drivers"].clone(),
    }
}

/// What onboarding asks for, grouped the same way.
fn onboarding_reads(document: &Document) -> PlanReads {
    let mut reads = PlanReads {
        endpoints: Vec::new(),
        engine: None,
        hardware: BTreeSet::new(),
        fabric: Vec::new(),
        gateway_drivers: Value::Null,
    };
    for query in fact_needs(document, None).unwrap() {
        match query {
            FactQuery::Endpoint(request) => reads.endpoints.push(request),
            FactQuery::Engine(request) => reads.engine = Some(request),
            FactQuery::Hardware { engine } => {
                reads.hardware.insert(engine);
            }
            FactQuery::Fabric { engine, image } => reads.fabric.push((engine, image)),
            FactQuery::Gateway {
                compute_drivers, ..
            } => reads.gateway_drivers = serde_json::to_value(compute_drivers).unwrap(),
            FactQuery::Credential { .. } => {}
        }
    }
    reads
}

fn assert_same_reads(document: &Document) {
    let (plan, onboarding) = (plan_reads(document), onboarding_reads(document));
    assert_eq!(onboarding.endpoints, plan.endpoints, "endpoint reads");
    assert_eq!(onboarding.engine, plan.engine, "engine read");
    assert_eq!(onboarding.hardware, plan.hardware, "hardware reads");
    assert_eq!(onboarding.fabric, plan.fabric, "image reads");
    assert_eq!(
        onboarding.gateway_drivers, plan.gateway_drivers,
        "gateway read"
    );
}

#[test]
fn a_managed_gateway_with_a_hosted_route_reads_what_plan_reads() {
    assert_same_reads(
        &Document::parse(&include_bytes!("../../../examples/onboarding/openclaw.yaml")[..])
            .unwrap(),
    );
}

#[test]
fn an_external_gateway_reads_only_its_image_store_like_plan() {
    let mut document =
        Document::parse(&include_bytes!("../../../examples/onboarding/openclaw.yaml")[..]).unwrap();
    document.spec.gateway = serde_json::from_value(serde_json::json!({
        "management": "external",
        "endpoint": "https://gateway.example:8080",
        "engine": "ssh://images@example.com",
    }))
    .unwrap();
    assert_same_reads(&document);
}

#[test]
fn a_service_backed_route_has_no_endpoint_read_in_either_path() {
    let document =
        Document::parse(&include_bytes!("../../../examples/spark/remote-vllm.yaml")[..]).unwrap();
    let (plan, onboarding) = (plan_reads(&document), onboarding_reads(&document));
    assert!(plan.endpoints.is_empty() && onboarding.endpoints.is_empty());
    assert_eq!(onboarding.gateway_drivers, plan.gateway_drivers);
}

/// An external gateway with no engine has nowhere to read its image from.
/// Plan still compiles the read, with an empty engine, so that it can fail
/// with "set spec.gateway.engine". Onboarding makes no read, because it never
/// targets a local daemon for an unresolved engine, and reports the missing
/// engine itself.
#[test]
fn an_unresolved_engine_is_the_other_named_difference() {
    let document =
        Document::parse(&include_bytes!("../../../examples/spark/remote-vllm.yaml")[..]).unwrap();
    let (plan, onboarding) = (plan_reads(&document), onboarding_reads(&document));
    assert_eq!(plan.fabric.len(), 1);
    assert_eq!(plan.fabric[0].0, "");
    assert!(onboarding.fabric.is_empty());
}

/// Plan also probes the engine of every managed service. Onboarding probes
/// hardware only for the gateway's engine until a decision consumes the rest.
#[test]
fn hardware_of_service_engines_is_the_named_difference() {
    let document =
        Document::parse(&include_bytes!("../../../examples/spark/remote-vllm.yaml")[..]).unwrap();
    let (plan, onboarding) = (plan_reads(&document), onboarding_reads(&document));
    assert_eq!(plan.hardware, BTreeSet::from(["ssh://gpu-box".to_string()]));
    assert!(onboarding.hardware.is_empty());
}
