// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-hermes.yaml")).unwrap();
    value["spec"]["inferenceProviders"] = json!([
        {
            "name": "judge",
            "provider": "openai",
            "api": "openai-completions",
            "endpoint": "https://judge.example/v1",
            "credential": {"env": "JUDGE_KEY"}
        },
        {
            "name": "weak",
            "provider": "openai",
            "api": "openai-completions",
            "endpoint": "https://weak.example/v1",
            "credential": {"env": "WEAK_KEY"}
        },
        {
            "name": "strong",
            "provider": "openai",
            "api": "openai-completions",
            "endpoint": "https://strong.example/v1",
            "credential": {"env": "STRONG_KEY"}
        }
    ]);
    value["spec"]["sandboxes"][0]["agent"]["inference"] = json!({
        "default": "weak",
        "routes": [
            {
                "name": "judge",
                "providerRef": "judge",
                "overrides": {"model": "provider/judge"}
            },
            {
                "name": "weak",
                "providerRef": "weak",
                "overrides": {"model": "provider/weak"}
            },
            {
                "name": "strong",
                "providerRef": "strong",
                "overrides": {"model": "provider/strong"}
            }
        ],
        "routing": {
            "kind": "switchyard",
            "routeId": "smart",
            "algorithm": {
                "kind": "llm-classifier",
                "classifierRoute": "judge",
                "weakRoute": "weak",
                "strongRoute": "strong",
                "baseThreshold": 0.5,
                "thresholdStep": 0.1
            }
        }
    });
    value
}

fn generations() -> Generations {
    ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into()
}

#[test]
fn hermes_switchyard_routing_preserves_typed_intent_and_provider_boundaries() {
    let value = input();
    let document = Document::parse(value.to_string().as_bytes()).expect("Switchyard routing");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let rows = targets(&document, &generations()).unwrap();
    let runtime: Value = serde_json::from_str(
        &rows
            .iter()
            .find(|target| target.kind == "sandbox")
            .unwrap()
            .values["inference_json"],
    )
    .unwrap();
    assert_eq!(
        runtime["routing"],
        value["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]
    );
    let models = runtime["agents"][0]["inference"]["models"]
        .as_object()
        .unwrap();
    assert_eq!(models.len(), 3);
    assert_eq!(
        models["judge"]["connection"]["api_key_env"],
        "NEMOCLAW_INFERENCE_JUDGE_KEY"
    );
    assert_eq!(
        models["weak"]["connection"]["api_key_env"],
        "NEMOCLAW_INFERENCE_WEAK_KEY"
    );
    assert_eq!(
        models["strong"]["connection"]["api_key_env"],
        "NEMOCLAW_INFERENCE_STRONG_KEY"
    );
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}

#[test]
fn seeded_weighted_random_uses_named_routes_without_copying_provider_configuration() {
    let mut value = input();
    value["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"] = json!({
        "kind": "weighted-random",
        "seed": 42,
        "targets": [
            {"routeRef": "weak", "weight": 7},
            {"routeRef": "strong", "weight": 3}
        ]
    });
    let routes = value["spec"]["sandboxes"][0]["agent"]["inference"]["routes"]
        .as_array_mut()
        .unwrap();
    routes.remove(0);
    let document = Document::parse(value.to_string().as_bytes()).expect("weighted routing");
    let rows = targets(&document, &generations()).unwrap();
    let runtime: Value = serde_json::from_str(
        &rows
            .iter()
            .find(|target| target.kind == "sandbox")
            .unwrap()
            .values["inference_json"],
    )
    .unwrap();
    assert_eq!(runtime["routing"]["algorithm"]["seed"], 42);
    assert_eq!(
        runtime["routing"]["algorithm"]["targets"][0],
        json!({"routeRef": "weak", "weight": 7})
    );
}

#[test]
fn switchyard_routing_rejects_unsupported_harnesses_and_broken_route_references() {
    let mut openclaw = input();
    openclaw["spec"]["sandboxes"][0]["harness"]["kind"] = json!("openclaw");
    let mut missing = input();
    missing["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["classifierRoute"] =
        json!("missing");
    let mut duplicate = input();
    duplicate["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["strongRoute"] =
        json!("weak");
    let mut unknown_kind = input();
    unknown_kind["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["kind"] =
        json!("stage-router");
    let mut shared_provider = input();
    shared_provider["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][2]["providerRef"] =
        json!("weak");
    let mut zero_step = input();
    zero_step["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["thresholdStep"] =
        json!(0);
    for invalid in [
        openclaw,
        missing,
        duplicate,
        unknown_kind,
        shared_provider,
        zero_step,
    ] {
        assert!(Document::parse(invalid.to_string().as_bytes()).is_err());
    }
}
