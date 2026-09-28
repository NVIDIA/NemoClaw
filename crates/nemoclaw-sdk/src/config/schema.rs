// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored YAML represented as JSON, before Document::defaults runs.
pub(crate) mod validation;

pub const SCHEMA_PATH: &str = "schemas/nemoclaw-v1alpha1.schema.json";

pub fn input_schema() -> serde_json::Value {
    build_schema(false)
}

fn build_schema(normalized: bool) -> serde_json::Value {
    let settings = schemars::generate::SchemaSettings::draft2020_12();
    let mut schema = serde_json::to_value(
        settings
            .into_generator()
            .into_root_schema_for::<super::Document>(),
    )
    .unwrap();
    remove_serde_defaults(&mut schema);
    validation::constrain(&mut schema, normalized);
    schema["$id"] = serde_json::json!("urn:nemoclaw:config:v1alpha1");
    schema["title"] = serde_json::json!("NemoClaw configuration (v1alpha1)");
    schema["$comment"] = serde_json::json!(
        "SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. SPDX-License-Identifier: Apache-2.0. Generated from the SDK; do not edit."
    );
    schema.sort_all_objects();
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

mod runtime;
pub(crate) use runtime::{
    validate_definition, validate_document, validate_input, validate_property, validate_service,
    validate_tuning,
};
