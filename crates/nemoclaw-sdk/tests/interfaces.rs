// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};

#[test]
fn adapter_defined_interfaces_survive_without_sdk_registration() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    for interfaces in [
        json!({"custom-frontend":{"transport":"stdio", "future":null}}),
        json!({"dashboard":{"port":8642,"bind":"127.0.0.1"}}),
        json!({"api":{"port":9000},"dashboard":{"enabled":false}}),
    ] {
        value["spec"]["sandboxes"][0]["harness"]["settings"]["interfaces"] = interfaces.clone();
        let document = Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap();
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
        assert_eq!(
            serde_json::to_value(
                &document.spec.sandboxes[0]
                    .harness
                    .as_ref()
                    .unwrap()
                    .settings
                    .as_ref()
                    .unwrap()["interfaces"]
            )
            .unwrap(),
            interfaces
        );
    }
}

#[test]
fn interface_configuration_requires_an_object() {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for invalid in [json!(null), json!([]), json!(true), json!("dashboard")] {
        value["spec"]["sandboxes"][0]["harness"]["settings"] = invalid;
        assert!(!validator.is_valid(&value));
        assert!(Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).is_err());
    }
}
