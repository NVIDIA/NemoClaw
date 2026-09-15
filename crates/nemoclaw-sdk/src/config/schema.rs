// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored YAML represented as JSON, before Document::defaults runs.
mod validation;

pub fn input_schema() -> serde_json::Value {
    let settings = schemars::generate::SchemaSettings::draft2020_12();
    let mut schema = serde_json::to_value(
        settings
            .into_generator()
            .into_root_schema_for::<super::Document>(),
    )
    .unwrap();
    remove_serde_defaults(&mut schema);
    validation::constrain(&mut schema);
    schema
}

// Serde defaults are intermediate empty values, not Document::defaults results.
fn remove_serde_defaults(schema: &mut serde_json::Value) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    object.remove("default");
    for key in ["properties", "$defs"] {
        if let Some(children) = object
            .get_mut(key)
            .and_then(serde_json::Value::as_object_mut)
        {
            for child in children.values_mut() {
                remove_serde_defaults(child);
            }
        }
    }
    for key in ["items", "additionalProperties"] {
        if let Some(child) = object.get_mut(key) {
            remove_serde_defaults(child);
        }
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        if let Some(children) = object
            .get_mut(key)
            .and_then(serde_json::Value::as_array_mut)
        {
            for child in children {
                remove_serde_defaults(child);
            }
        }
    }
}
