// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored YAML represented as JSON, before Document::defaults runs.
pub(crate) mod validation;

// Editors select union variants the same way schema diagnostics do.
pub use nemoclaw_runtime::schema::select_variant;
pub use nemoclaw_runtime::schema::variant_keys;

pub const SCHEMA_PATH: &str = "schemas/nemoclaw-v1alpha1.schema.json";

pub fn input_schema() -> serde_json::Value {
    input_schema_ref().clone()
}

/// The input schema without a copy. Generating it costs more than most
/// checks against it, so a process generates it once.
pub fn input_schema_ref() -> &'static serde_json::Value {
    static INPUT: std::sync::LazyLock<serde_json::Value> =
        std::sync::LazyLock::new(|| build_schema(false));
    &INPUT
}

/// The input schema compiled, for callers that check authored input against
/// it: compiling it costs more than most checks, so a process compiles it once.
pub fn input_validator() -> &'static jsonschema::Validator {
    runtime::input_validator()
}

fn build_schema(normalized: bool) -> serde_json::Value {
    // The input and normalized schemas constrain one generated schema, and
    // generating it costs more than copying it.
    static GENERATED: std::sync::LazyLock<serde_json::Value> = std::sync::LazyLock::new(|| {
        let settings = schemars::generate::SchemaSettings::draft2020_12();
        let mut schema = settings
            .into_generator()
            .into_root_schema_for::<super::Document>()
            .to_value();
        remove_serde_defaults(&mut schema);
        // nemoclaw_openshell::policy::definitions bounds the policy types the
        // same way, so its definitions stay equal to these.
        nemoclaw_runtime::schema::bound_integers(&mut schema);
        schema
    });
    let mut schema = GENERATED.clone();
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

pub use nemoclaw_runtime::schema::integer_range;

mod runtime;
pub use runtime::unexplained_rules;
pub(crate) use runtime::{
    validate_definition, validate_document, validate_input, validate_property, validate_service,
    validate_tuning,
};
