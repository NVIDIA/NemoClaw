// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    value["spec"]["sandboxes"][0]["harness"] =
        json!({"kind":"openclaw", "execution":{"timeoutSeconds":900}});
    value
}
fn shared(mut value: Value, sandbox: bool) -> Value {
    let harness = value["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("harness")
        .unwrap();
    value["spec"]["sandboxes"][0]["harnessRef"] = json!("assistant");
    let scope = if sandbox {
        &mut value["spec"]["sandboxes"][0]
    } else {
        &mut value["spec"]
    };
    scope["harnesses"] = json!({"assistant":harness});
    value
}
#[test]
fn shared_harness_configuration_compiles_identically_and_survives_export() {
    let original = Document::parse(input().to_string().as_bytes()).expect("typed inline harness");
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    for mut value in [shared(input(), false), shared(input(), true)] {
        let doc = Document::parse(value.to_string().as_bytes()).unwrap();
        assert!(
            jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&value)
        );
        assert_eq!(
            targets(&doc, &generations).unwrap(),
            targets(&original, &generations).unwrap()
        );
        assert_eq!(
            Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
            doc
        );
        let mut other = value["spec"]["sandboxes"][0].clone();
        other["name"] = json!("writer");
        value["spec"]["sandboxes"]
            .as_array_mut()
            .unwrap()
            .push(other);
        let doc = Document::parse(value.to_string().as_bytes()).unwrap();
        let rows = targets(&doc, &generations).unwrap();
        let runtime: Value = serde_json::from_str(
            &rows
                .iter()
                .find(|row| row.kind == "sandbox")
                .unwrap()
                .values["inference_json"],
        )
        .unwrap();
        assert_eq!(runtime["execution"]["timeoutSeconds"], 900);
        assert_eq!(runtime["agents"].as_array().unwrap().len(), 1);
    }
}
#[test]
fn sandbox_harness_selection_rejects_ambiguity_agent_selection_and_unsupported_counts() {
    let mut missing = shared(input(), false);
    missing["spec"]["sandboxes"][0]["harnessRef"] = json!("missing");
    let mut both = shared(input(), false);
    both["spec"]["sandboxes"][0]["harness"] = json!({"kind":"openclaw"});
    let mut shadow = shared(input(), false);
    shadow["spec"]["sandboxes"][0]["harnesses"] = shadow["spec"]["harnesses"].clone();
    let mut absent = input();
    absent["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("harness");
    let mut legacy = input();
    legacy["spec"]["sandboxes"][0]["agent"]["harness"] = json!({"kind":"openclaw"});
    let mut legacy_ref = input();
    legacy_ref["spec"]["sandboxes"][0]["agent"]["harnessRef"] = json!("assistant");
    let mut limited = input();
    limited["spec"]["gateway"] =
        json!({"management":"external","endpoint":"http://127.0.0.1:8080"});
    limited["spec"]["sandboxes"][0]["harness"] = json!({"kind":"hermes"});
    let mut other = limited["spec"]["sandboxes"][0]["agent"].clone();
    other["name"] = json!("other");
    limited["spec"]["sandboxes"][0]["agents"] = json!([other]);
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for value in [absent, both, legacy, legacy_ref, limited] {
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!schema.is_valid(&value));
    }
    for value in [missing, shadow] {
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
    }
}
#[test]
fn unused_harness_is_validated_without_granting_access() {
    let mut value = input();
    value["spec"]["harnesses"] = json!({"unused":{"kind":"openclaw", "observability":{"otlp":{"enabled":true,"endpoint":"http://host.openshell.internal:4318","serviceName":"unused","sampleRate":1.0}}}});
    let doc = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), "a".repeat(32)))
        .into();
    assert_eq!(
        targets(&doc, &generations).unwrap(),
        targets(
            &Document::parse(input().to_string().as_bytes()).unwrap(),
            &generations
        )
        .unwrap()
    );
    value["spec"]["harnesses"]["unused"]["kind"] = json!("invalid");
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
}
