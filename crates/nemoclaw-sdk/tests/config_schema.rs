// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{Document, schema::input_schema};
use serde_json::{Value, json};

fn input(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples")
        .join(name);
    serde_saphyr::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn agrees(validator: &jsonschema::Validator, value: &Value, accepted: bool) {
    assert_eq!(
        Document::parse(value.to_string().as_bytes()).is_ok(),
        accepted,
        "parser: {value}"
    );
    assert_eq!(
        validator.is_valid(value),
        accepted,
        "schema errors: {:?}",
        validator.iter_errors(value).collect::<Vec<_>>()
    );
}

#[test]
fn input_schema_rejects_missing_required_fields_and_structural_nulls() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let original = input("local.yaml");
    agrees(&validator, &original, true);
    for path in [
        "/apiVersion",
        "/kind",
        "/metadata",
        "/metadata/name",
        "/metadata/uid",
        "/spec",
        "/spec/gateway",
        "/spec/gateway/management",
        "/spec/inferenceProviders",
        "/spec/inferenceProviders/0/name",
        "/spec/sandboxes",
        "/spec/sandboxes/0/name",
        "/spec/sandboxes/0/agents",
        "/spec/sandboxes/0/agents/0/harness",
        "/spec/sandboxes/0/agents/0/inference",
        "/spec/sandboxes/0/agents/0/inference/routes/0/overrides/model",
    ] {
        let mut value = original.clone();
        let (parent, key) = path.rsplit_once('/').unwrap();
        value
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(key);
        agrees(&validator, &value, false);
    }
    for (parent, key) in [
        ("/spec/gateway", "credential"),
        ("/spec/gateway", "tls"),
        ("/spec/inferenceProviders/0", "service"),
        ("/spec/inferenceProviders/0", "ollama"),
    ] {
        let mut value = original.clone();
        value.pointer_mut(parent).unwrap()[key] = Value::Null;
        agrees(&validator, &value, false);
    }
}

#[test]
fn input_schema_preserves_defaults_strict_objects_and_opaque_pi_metadata() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = input("spark-inline.yaml");
    for key in ["endpoint", "engine", "image", "networkCIDR"] {
        value["spec"]["gateway"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["image", "network", "runtime"] {
        value["spec"]["sandboxes"][0]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    for key in ["serving", "memory"] {
        value["spec"]["inferenceProviders"][0]["service"]
            .as_object_mut()
            .unwrap()
            .remove(key);
    }
    agrees(&validator, &value, true);
    value["spec"]["gateway"]["surprise"] = json!(true);
    agrees(&validator, &value, false);
    let mut value = input("fabric-pi.yaml");
    let path = "/spec/sandboxes/0/agents/0/inference/routes/0/overrides/piModel";
    *value.pointer_mut(path).unwrap() = json!({"future": [null, {"value": null}]});
    agrees(&validator, &value, true);
    *value.pointer_mut(path).unwrap() = Value::Null;
    agrees(&validator, &value, false);
}
