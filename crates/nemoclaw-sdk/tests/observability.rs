// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap()
}
fn telemetry() -> Value {
    json!({"otlp":{"enabled":true,"endpoint":"http://host.openshell.internal:4318","serviceName":"agent ${fixture} %{literal}","sampleRate":0.5}})
}
fn relay() -> Value {
    json!({"relay":{"enabled":true}})
}
#[test]
fn telemetry_preserves_intent_and_adds_only_collector_egress() {
    let mut value = input();
    value["spec"]["sandboxes"][0]["agents"][0]["observability"] = telemetry();
    let doc = Document::parse(value.to_string().as_bytes()).expect("OTLP settings must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    assert_eq!(
        Document::parse(doc.yaml().unwrap().as_bytes()).unwrap(),
        doc
    );
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    let runtime: Value = serde_json::from_str(&rows[3].values["inference_json"]).unwrap();
    assert_eq!(runtime["observability"], telemetry());
    let graph = compile(&doc, &generations, "0.1.0").unwrap();
    assert!(
        graph["resource"]["nemoclaw_sandbox"]["agent"]["inference_json"]
            .as_str()
            .unwrap()
            .contains("agent $${fixture} %%{literal}"),
        "OpenTofu must receive literal service names"
    );
    let policy: Value = serde_json::from_str(&rows[3].values["policy_json"]).unwrap();
    let rules = policy["network_policies"].as_object().unwrap();
    assert_eq!(rules.len(), 2);
    let endpoint = &rules["nemoclaw-otlp"]["endpoints"][0];
    assert_eq!(endpoint["host"], "host.openshell.internal");
    assert_eq!(endpoint["port"], 4318);
    assert_eq!(
        endpoint["rules"],
        json!([{"allow":{"method":"POST","path":"/v1/traces"}}])
    );
    value["spec"]["sandboxes"][0]["network"] = json!({"policy":{"explicit":policy}});
    assert!(
        Document::parse(value.to_string().as_bytes()).is_err(),
        "reserved egress rules must not override explicit policy"
    );
}
#[test]
fn invalid_telemetry_is_rejected_before_planning() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for (field, invalid) in [
        ("enabled", json!(false)),
        ("endpoint", json!("https://collector.example")),
        ("sampleRate", json!(-0.1)),
        ("sampleRate", json!(1.1)),
        ("serviceName", json!("")),
        ("serviceName", json!("with\nnewline")),
        ("serviceName", json!(" leading")),
    ] {
        let mut value = input();
        let mut otlp = telemetry();
        otlp["otlp"][field] = invalid;
        value["spec"]["sandboxes"][0]["agents"][0]["observability"] = otlp;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!schema.is_valid(&value));
    }
    let mut value = input();
    let mut agent = value["spec"]["sandboxes"][0]["agents"][0].clone();
    agent["name"] = json!("reader");
    agent["observability"] = telemetry();
    value["spec"]["sandboxes"][0]["agents"]
        .as_array_mut()
        .unwrap()
        .push(agent);
    assert!(Document::parse(value.to_string().as_bytes()).is_err());
    assert!(!schema.is_valid(&value));
}

#[test]
fn hermes_relay_tracing_selects_in_process_runtime_without_new_egress() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-hermes.yaml")).unwrap();
    value["spec"]["sandboxes"][0]["agents"][0]["observability"] = relay();
    let doc = Document::parse(value.to_string().as_bytes()).expect("Relay settings must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    let runtime: Value = serde_json::from_str(&rows[3].values["inference_json"]).unwrap();
    assert_eq!(runtime["observability"], relay());
    let policy: Value = serde_json::from_str(&rows[3].values["policy_json"]).unwrap();
    let rules = policy["network_policies"].as_object().unwrap();
    assert_eq!(rules.len(), 1);
    assert!(
        rules
            .keys()
            .all(|key| key.starts_with("nemoclaw-inference-"))
    );
}

#[test]
fn relay_tracing_rejects_unsupported_combinations() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    let hermes: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-hermes.yaml")).unwrap();
    for observability in [
        json!({"relay":{"enabled":false}}),
        json!({"relay":{"enabled":true},"otlp":{"enabled":true,"endpoint":"http://host.openshell.internal:4318","serviceName":"fixture","sampleRate":1}}),
    ] {
        let mut value = hermes.clone();
        value["spec"]["sandboxes"][0]["agents"][0]["observability"] = observability;
        assert!(Document::parse(value.to_string().as_bytes()).is_err());
        assert!(!schema.is_valid(&value));
    }
    let mut with_interfaces = hermes;
    with_interfaces["spec"]["sandboxes"][0]["agents"][0]["observability"] = relay();
    with_interfaces["spec"]["sandboxes"][0]["agents"][0]["interfaces"] =
        json!({"dashboard":{"enabled":false}});
    assert!(Document::parse(with_interfaces.to_string().as_bytes()).is_err());
    assert!(!schema.is_valid(&with_interfaces));
}
