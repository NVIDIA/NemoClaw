// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn input(count: usize) -> Value {
    let mut v: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-openclaw.yaml")).unwrap();
    let primary = v["spec"]["sandboxes"][0]["agents"][0].clone();
    v["spec"]["sandboxes"][0]["agents"] = Value::Array(
        (0..count)
            .map(|n| {
                let mut a = primary.clone();
                a["name"] = json!(format!("agent-{n}"));
                if n != 0 {
                    a["tools"] = json!({"allow":["read"]});
                }
                a
            })
            .collect(),
    );
    v
}
fn parse(v: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(v.to_string().as_bytes())
}
#[test]
fn one_or_many_agents_preserve_restrictions_in_launch_and_yaml() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for count in [1, 3, 12] {
        let v = input(count);
        let d = parse(&v).expect("one or more agents must parse");
        assert!(schema.is_valid(&v));
        assert_eq!(Document::parse(d.yaml().unwrap().as_bytes()).unwrap(), d);
        let g: Generations = ["workspace", "provider", "sandbox"]
            .map(|k| (k.into(), format!("{k}-generation")))
            .into();
        let rows = targets(&d, &g).unwrap();
        if count > 1 {
            let settings: Value = serde_json::from_str(&rows[3].values["inference_json"]).unwrap();
            assert_eq!(settings["agents"].as_array().unwrap().len(), count);
            assert_eq!(
                settings["agents"][1],
                json!({"name":"agent-1","tools":{"allow":["read"]}})
            );
        }
    }
    let mut v = input(1);
    v["spec"]["sandboxes"][0]["agents"][0]["tools"] = json!({"allow":["read"]});
    assert!(parse(&v).is_ok());
    assert!(schema.is_valid(&v));
}
#[test]
fn invalid_rosters_and_permissions_fail_before_planning() {
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
        v["spec"]["sandboxes"][0]["agents"][1]["tools"] = tools;
        assert!(parse(&v).is_err());
        assert!(!schema.is_valid(&v));
    }
    let mut v = input(3);
    v["spec"]["sandboxes"][0]["agents"][1]["name"] = json!("agent-0");
    assert!(parse(&v).is_err());
    let mut v = input(3);
    v["spec"]["sandboxes"][0]["agents"][1]["harness"] = json!("hermes");
    assert!(parse(&v).is_err());
    assert!(!schema.is_valid(&v));
    let mut v = input(3);
    v["spec"]["sandboxes"][0]["agents"][2]["inference"]["routes"][0]["overrides"]["model"] =
        json!("another-model");
    assert!(parse(&v).is_err());
}

#[test]
fn disclosure_round_trips_and_rejects_conflicting_gateway_modes() {
    let schema = jsonschema::validator_for(&input_schema()).unwrap();
    for mode in ["progressive", "direct"] {
        let mut v = input(3);
        v["spec"]["sandboxes"][0]["agents"][0]["tools"] = json!({"disclosure":mode});
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
        v["spec"]["sandboxes"][0]["agents"][0]["tools"] = tools;
        assert!(parse(&v).is_err());
        assert!(!schema.is_valid(&v));
    }
    let mut v = input(3);
    v["spec"]["sandboxes"][0]["agents"][0]["tools"] = json!({"disclosure":"direct"});
    v["spec"]["sandboxes"][0]["agents"][1]["tools"] = json!({"disclosure":"progressive"});
    assert!(parse(&v).is_err());
    v["spec"]["sandboxes"][0]["agents"][1]
        .as_object_mut()
        .unwrap()
        .remove("tools");
    assert!(
        parse(&v).is_err(),
        "omitted unrestricted mode means progressive"
    );
}
