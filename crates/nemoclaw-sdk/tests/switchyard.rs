// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{config::Document, fabric_config};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value = crate::support::example("fabric-hermes.yaml");
    value["spec"]["inferenceProviders"] = json!([
        {
            "name": "judge",
            "provider": "openai",
            "endpoint": "https://judge.example/v1",
            "credential": {"env": "JUDGE_KEY"}
        },
        {
            "name": "weak",
            "provider": "openai",
            "endpoint": "https://weak.example/v1",
            "credential": {"env": "WEAK_KEY"}
        },
        {
            "name": "strong",
            "provider": "openai",
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

#[test]
fn switchyard_intent_round_trips_but_fails_closed_before_fabric_projection() {
    let document = Document::parse(input().to_string().as_bytes()).expect("Switchyard routing");
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    assert_eq!(
        document.credential_names(),
        ["JUDGE_KEY", "STRONG_KEY", "WEAK_KEY"]
    );
    assert_eq!(
        fabric_config::for_sandbox(&document, &document.spec.sandboxes[0])
            .unwrap_err()
            .to_string(),
        "Switchyard routing requires a qualified Fabric adapter"
    );
}

#[test]
fn seeded_weighted_random_accepts_two_distinct_named_routes() {
    let mut value = input();
    value["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"] = json!({
        "kind": "weighted-random",
        "seed": 42,
        "targets": [
            {"routeRef": "weak", "weight": 7},
            {"routeRef": "strong", "weight": 3}
        ]
    });
    value["spec"]["sandboxes"][0]["agent"]["inference"]["routes"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    Document::parse(value.to_string().as_bytes()).expect("weighted Switchyard routing");
}

#[test]
fn switchyard_rejects_unsupported_harnesses_and_ambiguous_route_bindings() {
    let mut openclaw = input();
    openclaw["spec"]["sandboxes"][0]["harness"]["kind"] = json!("nvidia.fabric.openclaw");
    let mut missing = input();
    missing["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["classifierRoute"] =
        json!("missing");
    let mut duplicate = input();
    duplicate["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["strongRoute"] =
        json!("weak");
    let mut shared_provider = input();
    shared_provider["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][2]["providerRef"] =
        json!("weak");
    let mut zero_step = input();
    zero_step["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["thresholdStep"] =
        json!(0);
    let mut unknown_kind = input();
    unknown_kind["spec"]["sandboxes"][0]["agent"]["inference"]["routing"]["algorithm"]["kind"] =
        json!("stage-router");

    for invalid in [
        openclaw,
        missing,
        duplicate,
        shared_provider,
        zero_step,
        unknown_kind,
    ] {
        assert!(Document::parse(invalid.to_string().as_bytes()).is_err());
    }
}
