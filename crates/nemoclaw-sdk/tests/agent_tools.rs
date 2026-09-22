// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input(count: usize) -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    let primary = value["spec"]["sandboxes"][0].clone();
    value["spec"]["sandboxes"] = Value::Array(
        (0..count)
            .map(|n| {
                let mut sandbox = primary.clone();
                sandbox["name"] = json!(format!("sandbox-{n}"));
                sandbox["agent"]["name"] = json!(format!("agent-{n}"));
                if n != 0 {
                    sandbox["agent"]["tools"] = json!({"allow":["read"]});
                }
                sandbox
            })
            .collect(),
    );
    value
}
fn parse(v: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(v.to_string().as_bytes())
}
#[test]
fn separate_sandboxes_preserve_each_agents_restrictions_in_launch_and_yaml() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for count in [1, 3, 12] {
        let v = input(count);
        let d = parse(&v).expect("one agent per sandbox must parse");
        assert!(schema.is_valid(&v));
        assert_eq!(Document::parse(d.yaml().unwrap().as_bytes()).unwrap(), d);
        let g: Generations = ["workspace", "provider", "sandbox"]
            .map(|k| (k.into(), format!("{k}-generation")))
            .into();
        let rows = targets(&d, &g).unwrap();
        let sandboxes: Vec<_> = rows.iter().filter(|row| row.kind == "sandbox").collect();
        assert_eq!(sandboxes.len(), count);
        for sandbox in sandboxes {
            let settings: Value = serde_json::from_str(&sandbox.values["inference_json"]).unwrap();
            assert_eq!(settings["agents"].as_array().unwrap().len(), 1);
            if sandbox.values["name"] != "sandbox-0" {
                assert_eq!(settings["agents"][0]["tools"], json!({"allow":["read"]}));
            }
        }
    }
    let mut v = input(1);
    v["spec"]["sandboxes"][0]["agent"]["tools"] = json!({"allow":["read"]});
    assert!(parse(&v).is_ok());
    assert!(schema.is_valid(&v));
}
#[test]
fn invalid_sandboxes_and_permissions_fail_before_planning() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(parse(&input(0)).is_err());
    assert!(!schema.is_valid(&input(0)));
    for tools in [
        json!({}),
        json!({"allow":[]}),
        json!({"allow":["exec"]}),
        json!({"allow":["read","read"]}),
        json!({"allow":["read"],"alsoAllow":["exec"]}),
        json!(null),
    ] {
        let mut v = input(3);
        v["spec"]["sandboxes"][1]["agent"]["tools"] = tools;
        assert!(parse(&v).is_err());
        assert!(!schema.is_valid(&v));
    }
    let mut v = input(3);
    v["spec"]["sandboxes"][1]["name"] = json!("sandbox-0");
    assert!(parse(&v).is_err());
    let mut v = input(3);
    v["spec"]["sandboxes"][1]["agent"]["harness"]["kind"] = json!("hermes");
    assert!(parse(&v).is_err());
    assert!(!schema.is_valid(&v));
}

#[test]
fn disclosure_round_trips_and_is_independent_between_gateways() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for mode in ["progressive", "direct"] {
        let mut v = input(3);
        v["spec"]["sandboxes"][0]["agent"]["tools"] = json!({"disclosure":mode});
        let d = parse(&v).expect("disclosure must parse");
        assert!(schema.is_valid(&v));
        assert_eq!(Document::parse(d.yaml().unwrap().as_bytes()).unwrap(), d);
        let g: Generations = ["workspace", "provider", "sandbox"]
            .map(|k| (k.into(), format!("{k}-generation")))
            .into();
        let rows = targets(&d, &g).unwrap();
        let settings: Value = serde_json::from_str(&rows[3].values["inference_json"]).unwrap();
        assert_eq!(settings["agents"][0]["tools"]["disclosure"], mode);
    }
    for tools in [
        json!({"disclosure":"DIRECT"}),
        json!({"disclosure":null}),
        json!({"disclosure":"other"}),
        json!({"allow":["read"],"disclosure":"direct"}),
    ] {
        let mut v = input(1);
        v["spec"]["sandboxes"][0]["agent"]["tools"] = tools;
        assert!(parse(&v).is_err());
        assert!(!schema.is_valid(&v));
    }
    let mut v = input(3);
    v["spec"]["sandboxes"][0]["agent"]["tools"] = json!({"disclosure":"direct"});
    v["spec"]["sandboxes"][1]["agent"]["tools"] = json!({"disclosure":"progressive"});
    let doc = parse(&v).expect("separate gateways accept independent disclosure modes");
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    for (name, mode) in [("sandbox-0", "direct"), ("sandbox-1", "progressive")] {
        let row = rows
            .iter()
            .find(|row| row.kind == "sandbox" && row.values["name"] == name)
            .unwrap();
        let settings: Value = serde_json::from_str(&row.values["inference_json"]).unwrap();
        assert_eq!(settings["agents"][0]["tools"]["disclosure"], mode);
    }
    v["spec"]["sandboxes"][1]["agent"]
        .as_object_mut()
        .unwrap()
        .remove("tools");
    assert!(
        parse(&v).is_ok(),
        "omitted disclosure is independent of the other gateway"
    );
}

#[test]
fn native_read_only_policies_reach_deep_agents_and_pi_without_disclosure_modes() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for harness in ["deepagents", "pi"] {
        let mut value = input(1);
        value["spec"]["sandboxes"][0]["harness"]["kind"] = json!(harness);
        value["spec"]["sandboxes"][0]["agent"]["tools"] = json!({"allow":["read"]});
        let document = parse(&value).expect("native read tool policy");
        assert!(schema.is_valid(&value));
        let generations = ["workspace", "provider", "sandbox"]
            .map(|key| (key.into(), "a".repeat(32)))
            .into();
        let rows = targets(&document, &generations).unwrap();
        let settings: Value = serde_json::from_str(
            &rows
                .iter()
                .find(|row| row.kind == "sandbox")
                .unwrap()
                .values["inference_json"],
        )
        .unwrap();
        assert_eq!(settings["agents"][0]["tools"], json!({"allow":["read"]}));
        for disclosure in ["direct", "progressive"] {
            value["spec"]["sandboxes"][0]["agent"]["tools"] = json!({"disclosure":disclosure});
            assert!(parse(&value).is_err());
            // Tool compatibility depends on the resolved harness, including harnessRef.
            assert!(schema.is_valid(&value));
        }
    }
}

#[test]
fn deep_agents_use_separate_sandboxes_with_stable_names_and_independent_models() {
    let mut value = input(2);
    for sandbox in value["spec"]["sandboxes"].as_array_mut().unwrap() {
        sandbox["harness"]["kind"] = json!("deepagents");
    }
    value["spec"]["sandboxes"][1]["agent"]["inference"]["routes"][0]["overrides"]["model"] =
        json!("other-model");
    let doc = parse(&value).expect("one native Deep Agents instance per sandbox");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
    let generations = ["workspace", "provider", "sandbox"]
        .map(|key| (key.into(), "a".repeat(32)))
        .into();
    let rows = targets(&doc, &generations).unwrap();
    let sandbox = rows
        .iter()
        .find(|row| row.kind == "sandbox" && row.values["name"] == "sandbox-1")
        .unwrap();
    assert_eq!(sandbox.values["agent_name"], "agent-1");
    let settings: Value = serde_json::from_str(&sandbox.values["inference_json"]).unwrap();
    assert_eq!(settings["connection"]["model"], "other-model");
    value["spec"]["sandboxes"].as_array_mut().unwrap().reverse();
    assert_eq!(
        targets(&parse(&value).unwrap(), &generations).unwrap(),
        rows
    );
}
