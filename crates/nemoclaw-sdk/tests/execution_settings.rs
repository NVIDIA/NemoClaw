// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap()
}
fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}
#[test]
fn execution_settings_reach_the_runtime_and_round_trip_with_many_agents() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for execution in [
        json!({"timeoutSeconds":900}),
        json!({"heartbeatEvery":"30m"}),
        json!({"timeoutSeconds":600,"heartbeatEvery":"0m"}),
    ] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["agents"][0]["execution"] = execution.clone();
        let mut reader = value["spec"]["sandboxes"][0]["agents"][0].clone();
        reader.as_object_mut().unwrap().remove("execution");
        reader["tools"] = json!({"allow":["read"]});
        for name in ["reader", "reviewer", "auditor"] {
            reader["name"] = json!(name);
            value["spec"]["sandboxes"][0]["agents"]
                .as_array_mut()
                .unwrap()
                .push(reader.clone());
        }
        let document = parse(&value).expect("execution settings must parse");
        assert!(schema.is_valid(&value));
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
        let generations: Generations = ["workspace", "provider", "sandbox"]
            .map(|key| (key.into(), "a".repeat(32)))
            .into();
        let rows = targets(&document, &generations).unwrap();
        let runtime: Value = serde_json::from_str(&rows[3].values["inference_json"]).unwrap();
        assert_eq!(runtime["execution"], execution);
        assert_eq!(runtime["agents"].as_array().unwrap().len(), 4);
        value["spec"]["sandboxes"][0]["agents"][1]["execution"] = json!({"timeoutSeconds":1200});
        assert!(
            parse(&value).is_err(),
            "execution belongs to the primary agent"
        );
        assert!(
            !schema.is_valid(&value),
            "schema must reject secondary execution"
        );
    }
}
#[test]
fn malformed_execution_fails_before_planning() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for execution in [
        json!({}),
        json!(null),
        json!({"timeoutSeconds":0}),
        json!({"timeoutSeconds":-1}),
        json!({"timeoutSeconds":1.5}),
        json!({"timeoutSeconds":1000000001_u64}),
        json!({"heartbeatEvery":"1d"}),
        json!({"heartbeatEvery":"30m\n"}),
        json!({"heartbeatEvery":null}),
        json!({"heartbeatEvery":"1m","extra":true}),
    ] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["agents"][0]["execution"] = execution;
        assert!(parse(&value).is_err());
        assert!(!schema.is_valid(&value));
    }
    let mut value = input();
    let agent = &mut value["spec"]["sandboxes"][0]["agents"][0];
    agent["harness"] = json!("hermes");
    agent["execution"] = json!({"timeoutSeconds":900});
    assert!(parse(&value).is_err());
    assert!(!schema.is_valid(&value));
}
