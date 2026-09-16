// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};
#[test]
fn openclaw_dashboard_settings_roundtrip_and_reject_reserved_ports() {
    let mut v: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    v["spec"]["sandboxes"][0]["agents"][0]["harness"]["interfaces"] =
        json!({"dashboard":{"port":18800,"bind":"127.0.0.1"}});
    let parse = |v: &Value| Document::parse(serde_json::to_vec(v).unwrap().as_slice());
    let d = parse(&v).expect("dashboard settings must parse");
    assert_eq!(Document::parse(d.yaml().unwrap().as_bytes()).unwrap(), d);
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(validator.is_valid(&v));
    for port in [0, 80, 8642, 8652, 65536] {
        v["spec"]["sandboxes"][0]["agents"][0]["harness"]["interfaces"]["dashboard"]["port"] =
            json!(port);
        assert!(parse(&v).is_err());
        assert!(!validator.is_valid(&v));
    }
}

#[test]
fn hermes_native_interfaces_preserve_explicit_enablement_and_reject_collisions() {
    let mut v: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-hermes.yaml")).unwrap();
    v["spec"]["sandboxes"][0]["agents"][0]["harness"]["interfaces"] = json!({
        "api": {"port":8643}, "dashboard":{"enabled":true,"port":18800,"internalPort":19120,"tui":{"enabled":true}}
    });
    let parse = |v: &Value| Document::parse(serde_json::to_vec(v).unwrap().as_slice());
    let document = parse(&v).expect("Hermes native interfaces must parse");
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&v)
    );
    for bad in [
        json!({}),
        json!({"api":{"port":9000}}),
        json!({"dashboard":{"enabled":false,"port":18800}}),
        json!({"dashboard":{"enabled":true,"port":8643}}),
        json!({"dashboard":{"enabled":true,"port":19120,"internalPort":19120}}),
    ] {
        v["spec"]["sandboxes"][0]["agents"][0]["harness"]["interfaces"] = bad;
        assert!(parse(&v).is_err());
    }
}
