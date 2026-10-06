// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pin the provider reads that planning derives from a document.
//!
//! Authoring and onboarding align their discovery queries to these inputs, so a
//! refactor of the SDK's query construction must leave them byte-identical.
use nemoclaw_sdk::{
    compile,
    config::{ComputeDriver, Document, ExternalGateway, Gateway},
    discovery::DiscoveryRequest,
    discovery::{DiscoveryQuery, plan_queries},
    fabric_capabilities::FabricRequirements,
    inference_discovery::endpoint_requests,
    services::{
        ServiceDefinition,
        placement::{ServicePlacement, ServicePublication},
    },
};
use serde_json::{Value, json};

const DATA_SOURCES: [&str; 4] = [
    "nemoclaw_engine_capabilities",
    "nemoclaw_fabric_capabilities",
    "nemoclaw_inference_capabilities",
    "nemoclaw_target_hardware",
];

fn discovery_graph(document: &Document) -> Value {
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
    let mut data = serde_json::Map::new();
    for source in DATA_SOURCES {
        if let Some(queries) = graph["data"].get(source) {
            data.insert(source.into(), queries.clone());
        }
    }
    json!({"data": data, "output": graph["output"]["discovery"]})
}

fn assert_pinned(document: &str, pinned: &str) {
    let document = Document::parse(document.as_bytes()).unwrap();
    let expected: Value = serde_json::from_str(pinned).unwrap();
    assert_eq!(
        discovery_graph(&document),
        expected,
        "{}",
        serde_json::to_string_pretty(&discovery_graph(&document)).unwrap()
    );
}

#[test]
fn onboarding_example_discovery_inputs_are_pinned() {
    assert_pinned(
        include_str!("../../../examples/onboarding/openclaw.yaml"),
        include_str!("fixtures/discovery_graph/openclaw.json"),
    );
}

#[test]
fn service_backed_routes_are_not_discovered_as_endpoints() {
    assert_pinned(
        include_str!("fixtures/config/spark.yaml"),
        include_str!("fixtures/discovery_graph/spark.json"),
    );
}

/// An external gateway with no image engine, and a service on another engine.
fn external_gateway_with_a_remote_service() -> Document {
    let mut document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    document.spec.gateway = Gateway::External(ExternalGateway {
        endpoint: "http://127.0.0.1:17681".into(),
        ..Default::default()
    });
    let ServiceDefinition::Vllm(service) = document.spec.services.get_mut("qwen").unwrap() else {
        panic!("fixture service")
    };
    service.placement = Some(ServicePlacement {
        engine: "ssh://operator@192.168.1.50".into(),
        network_cidr: "172.30.111.0/24".into(),
    });
    service.publication = Some(ServicePublication {
        endpoint: "http://192.168.1.50:18888/v1".into(),
        bind_address: "192.168.1.50".into(),
    });
    document
}

#[test]
fn external_gateway_discovery_never_substitutes_the_client_engine_for_a_service_target() {
    let document = external_gateway_with_a_remote_service();
    let expected: Value = serde_json::from_str(include_str!(
        "fixtures/discovery_graph/external-service.json"
    ))
    .unwrap();
    assert_eq!(
        discovery_graph(&document),
        expected,
        "{}",
        serde_json::to_string_pretty(&discovery_graph(&document)).unwrap()
    );
}

fn kinds(queries: &[DiscoveryQuery]) -> Vec<String> {
    queries
        .iter()
        .map(|query| {
            serde_json::to_value(query).unwrap()["kind"]
                .as_str()
                .unwrap()
                .into()
        })
        .collect()
}

#[test]
fn plan_queries_list_the_reads_of_a_managed_gateway_with_a_hosted_route() {
    let document =
        Document::parse(include_bytes!("../../../examples/onboarding/openclaw.yaml").as_slice())
            .unwrap();
    let queries = plan_queries(&document).unwrap();
    assert_eq!(
        kinds(&queries),
        ["gateway", "inference", "hardware", "engine", "fabric"]
    );
    let engine = "unix:///var/run/docker.sock";
    assert_eq!(
        queries[0],
        DiscoveryQuery::Gateway {
            gateway: document.spec.gateway.clone(),
            compute_drivers: vec![ComputeDriver::Docker],
        }
    );
    assert_eq!(
        queries[1],
        DiscoveryQuery::Inference(endpoint_requests(&document).unwrap().remove(0))
    );
    assert_eq!(
        queries[2],
        DiscoveryQuery::Hardware {
            engine: engine.into()
        }
    );
    let platform = DiscoveryRequest {
        engine: engine.into(),
        compute_driver: ComputeDriver::Docker,
    };
    assert_eq!(queries[3], DiscoveryQuery::Engine(platform.clone()));
    let sandbox = &document.spec.sandboxes[0];
    assert_eq!(
        queries[4],
        DiscoveryQuery::Fabric {
            engine: engine.into(),
            image: sandbox.image.ref_.clone(),
            requirements: FabricRequirements::for_sandbox(&document, sandbox).unwrap(),
            platform: Some(platform),
        }
    );
}

#[test]
fn plan_queries_skip_service_backed_routes() {
    let document =
        Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    assert_eq!(
        kinds(&plan_queries(&document).unwrap()),
        ["gateway", "hardware", "engine", "fabric"]
    );
}

#[test]
fn plan_queries_read_service_engines_and_an_unset_image_engine_for_an_external_gateway() {
    let queries = plan_queries(&external_gateway_with_a_remote_service()).unwrap();
    assert_eq!(kinds(&queries), ["gateway", "hardware", "fabric"]);
    assert_eq!(
        queries[1],
        DiscoveryQuery::Hardware {
            engine: "ssh://operator@192.168.1.50".into()
        }
    );
    // An external gateway's image store does not establish its platform.
    assert!(matches!(
        &queries[2],
        DiscoveryQuery::Fabric { engine, platform: None, .. } if engine.is_empty()
    ));
}
