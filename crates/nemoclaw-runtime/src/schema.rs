// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::ConfigError;
use serde_json::{Value, json};
/// Zero in authored YAML selects the default; validation uses normalized values.
pub struct DefaultedInteger {
    pub default: i64,
    pub min: i64,
    pub max: i64,
}

pub fn property(schema: &mut Value, field: &str, extra: Value) {
    let Value::Object(extra) = extra else {
        panic!("property constraints must be objects");
    };
    schema["properties"][field]
        .as_object_mut()
        .expect("derived field exists")
        .extend(extra);
}
pub fn integer(schema: &mut Value, field: &str, rule: &DefaultedInteger, normalized: bool) {
    property(
        schema,
        field,
        json!({
            "anyOf": if normalized { json!([{ "minimum": rule.min, "maximum": rule.max }]) } else { json!([{ "const": 0 }, { "minimum": rule.min, "maximum": rule.max }]) },
            "default": rule.default,
            "x-nemoclaw-default-rule": "Omitted or zero selects the default."
        }),
    );
}
pub fn forbid(names: &[&str]) -> Value {
    json!({"not": {"anyOf": names.iter().map(|name| json!({"required": [name]})).collect::<Vec<_>>()}})
}
// Required ancestors make a condition false when a field is omitted.
// Consequences constrain only fields that are present, allowing SDK defaults.
pub fn at(path: &str, rule: Value, required: bool) -> Value {
    path.split('/').rev().fold(rule, |child, segment| {
        if segment == "[]" {
            json!({"items": child})
        } else if required {
            json!({"required": [segment], "properties": {segment: child}})
        } else {
            json!({"properties": {segment: child}})
        }
    })
}

pub const MODEL: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$";
fn build() -> Value {
    let mut root = serde_json::to_value(schemars::schema_for!(crate::RuntimeSpec)).unwrap();
    let variants = root.get("oneOf").cloned().unwrap();
    let defs = root["$defs"].as_object_mut().unwrap();
    defs.insert("ServiceDefinition".into(), json!({"oneOf":variants}));
    crate::vllm::schema::constrain(defs, true);
    crate::ollama::constrain_schema(defs, true);
    let variants = defs.remove("ServiceDefinition").unwrap()["oneOf"].clone();
    root["oneOf"] = variants;
    root
}
static SCHEMA: std::sync::LazyLock<Value> = std::sync::LazyLock::new(build);
static VALIDATOR: std::sync::LazyLock<jsonschema::Validator> =
    std::sync::LazyLock::new(|| jsonschema::validator_for(&SCHEMA).expect("runtime schema"));
pub fn validate(spec: &crate::RuntimeSpec) -> Result<(), ConfigError> {
    if !VALIDATOR.is_valid(&serde_json::to_value(spec).expect("runtime spec")) {
        return Err(ConfigError::new("invalid pinned runtime specification"));
    }
    Ok(())
}

pub fn validate_recipe(
    recipe: &crate::vllm::recipes::inline::InlineRecipe,
) -> Result<(), ConfigError> {
    static VALIDATOR: std::sync::LazyLock<jsonschema::Validator> = std::sync::LazyLock::new(|| {
        jsonschema::validator_for(&json!({"$defs":SCHEMA["$defs"], "$ref":"#/$defs/InlineRecipe"}))
            .expect("recipe schema")
    });
    if !VALIDATOR.is_valid(&serde_json::to_value(recipe).expect("recipe")) {
        return Err(ConfigError::new(
            "invalid inline recipe contract or incompatible service",
        ));
    }
    Ok(())
}
