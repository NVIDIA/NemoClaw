// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};
#[test]
fn openclaw_dashboard_settings_roundtrip_and_reject_reserved_ports() {
    let mut v: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    v["spec"]["sandboxes"][0]["agents"][0]["interfaces"] =
        json!({"dashboard":{"port":18800,"bind":"127.0.0.1"}});
    let parse = |v: &Value| Document::parse(serde_json::to_vec(v).unwrap().as_slice());
    let d = parse(&v).expect("dashboard settings must parse");
    assert_eq!(Document::parse(d.yaml().unwrap().as_bytes()).unwrap(), d);
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(validator.is_valid(&v));
    for port in [0, 80, 8642, 8652, 65536] {
        v["spec"]["sandboxes"][0]["agents"][0]["interfaces"]["dashboard"]["port"] = json!(port);
        assert!(parse(&v).is_err());
        assert!(!validator.is_valid(&v));
    }
}
