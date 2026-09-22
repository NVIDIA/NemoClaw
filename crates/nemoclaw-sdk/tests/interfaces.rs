// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};
#[test]
fn openclaw_dashboard_settings_roundtrip_and_reject_reserved_ports() {
    let mut v: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    v["spec"]["sandboxes"][0]["harness"]["interfaces"] =
        json!({"dashboard":{"port":18800,"bind":"127.0.0.1"}});
    let parse = |v: &Value| Document::parse(serde_json::to_vec(v).unwrap().as_slice());
    let d = parse(&v).expect("dashboard settings must parse");
    assert_eq!(Document::parse(d.yaml().unwrap().as_bytes()).unwrap(), d);
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(validator.is_valid(&v));
    for port in [0, 80, 8642, 8652, 65536] {
        v["spec"]["sandboxes"][0]["harness"]["interfaces"]["dashboard"]["port"] = json!(port);
        assert!(parse(&v).is_err());
        assert!(!validator.is_valid(&v));
    }
}

#[test]
fn hermes_native_interfaces_preserve_explicit_enablement_and_reject_collisions() {
    let mut v: Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-hermes.yaml")).unwrap();
    v["spec"]["sandboxes"][0]["harness"]["interfaces"] = json!({
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
        v["spec"]["sandboxes"][0]["harness"]["interfaces"] = bad;
        assert!(parse(&v).is_err());
    }
}

#[test]
fn disabled_dashboard_cannot_deserialize_with_settings() {
    use nemoclaw_sdk::config::HermesDashboard;

    for field in [
        json!({"port": 18800}),
        json!({"internalPort": 19120}),
        json!({"tui": {"enabled": false}}),
    ] {
        let mut value = json!({"enabled": false});
        value
            .as_object_mut()
            .unwrap()
            .extend(field.as_object().unwrap().clone());
        assert!(
            serde_json::from_value::<HermesDashboard>(value.clone()).is_err(),
            "{value}"
        );
    }
    for value in [
        json!({"enabled": false}),
        json!({"enabled": true}),
        json!({"enabled": true, "port": 18800, "internalPort": 19120, "tui": {"enabled": false}}),
    ] {
        let dashboard: HermesDashboard = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&dashboard).unwrap(), value);
        let yaml = serde_saphyr::to_string(&dashboard).unwrap();
        assert_eq!(serde_saphyr::from_str::<Value>(&yaml).unwrap(), value);
    }
}

#[test]
fn sdk_dashboard_choices_preserve_disabled_and_enabled_defaults() {
    use nemoclaw_sdk::config::{HermesDashboard, HermesDashboardSettings};

    assert_eq!(
        serde_json::to_value(HermesDashboard::Disabled).unwrap(),
        json!({"enabled": false})
    );
    assert_eq!(
        serde_json::to_value(HermesDashboard::Enabled(HermesDashboardSettings::default())).unwrap(),
        json!({"enabled": true})
    );
}
