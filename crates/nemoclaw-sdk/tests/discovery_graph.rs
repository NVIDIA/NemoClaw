// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Pin the provider reads that planning derives from a document.
//!
//! Authoring and onboarding align their discovery queries to these inputs, so a
//! refactor of the SDK's query construction must leave them byte-identical.
use nemoclaw_sdk::{compile, config::Document};
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
