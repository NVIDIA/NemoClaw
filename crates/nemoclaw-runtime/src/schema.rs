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
    validate_value(&serde_json::to_value(spec).expect("runtime spec"))
}
pub(crate) fn validate_value(value: &Value) -> Result<(), ConfigError> {
    VALIDATOR
        .validate(value)
        .map_err(|error| diagnostic(&error))
}
/// A step toward a schema violation: a declared field, an array index, or
/// an undeclared key whose spelling is untrusted input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathSegment {
    Field(String),
    Index(usize),
    Key,
}

/// Where a runtime specification value first violates the schema.
pub fn violation(value: &Value) -> Option<Vec<PathSegment>> {
    let error = VALIDATOR.validate(value).err()?;
    Some(segments(innermost(&error)))
}

// Report the failing variant that the instance selected, not the union.
fn innermost<'e, 'a>(
    error: &'e jsonschema::ValidationError<'a>,
) -> &'e jsonschema::ValidationError<'a> {
    use jsonschema::error::ValidationErrorKind as Kind;
    if let Kind::OneOfNotValid { context } | Kind::AnyOf { context } = error.kind()
        && let Some(variants) = SCHEMA
            .pointer(error.schema_path().as_str())
            .and_then(Value::as_array)
    {
        for (variant, errors) in variants.iter().zip(context) {
            let matches_kind = variant["properties"]["kind"]
                .get("const")
                .is_some_and(|kind| error.instance().get("kind") == Some(kind));
            let matches_profile = variant["properties"].get("profile").is_some()
                && error.instance().get("profile").is_some();
            if (matches_kind || matches_profile)
                && let Some(error) = errors.first()
            {
                return innermost(error);
            }
        }
    }
    error
}

// Only declared schema field names may appear in diagnostics. Map keys,
// unknown properties, values and raw parser messages are untrusted.
static FIELDS: std::sync::LazyLock<std::collections::BTreeSet<String>> =
    std::sync::LazyLock::new(|| {
        fn collect(value: &Value, fields: &mut std::collections::BTreeSet<String>) {
            match value {
                Value::Object(object) => {
                    if let Some(properties) = object.get("properties").and_then(Value::as_object) {
                        fields.extend(properties.keys().cloned());
                    }
                    object.values().for_each(|value| collect(value, fields));
                }
                Value::Array(values) => values.iter().for_each(|value| collect(value, fields)),
                _ => {}
            }
        }
        let mut fields = std::collections::BTreeSet::new();
        collect(&SCHEMA, &mut fields);
        fields
    });

fn segments(error: &jsonschema::ValidationError<'_>) -> Vec<PathSegment> {
    use jsonschema::error::ValidationErrorKind as Kind;
    let location = error.instance_path().to_string();
    let mut path: Vec<_> = location
        .split('/')
        .skip(1)
        .map(|segment| {
            if FIELDS.contains(segment) {
                PathSegment::Field(segment.into())
            } else if let Ok(index) = segment.parse() {
                PathSegment::Index(index)
            } else {
                PathSegment::Key
            }
        })
        .collect();
    if let Kind::Required { property } = error.kind()
        && let Some(field) = property.as_str().filter(|field| FIELDS.contains(*field))
    {
        path.push(PathSegment::Field(field.into()));
    }
    path
}

fn diagnostic(error: &jsonschema::ValidationError<'_>) -> ConfigError {
    let error = innermost(error);
    let path: Vec<_> = segments(error)
        .into_iter()
        .map(|segment| match segment {
            PathSegment::Field(field) => field,
            PathSegment::Index(_) | PathSegment::Key => "*".into(),
        })
        .collect();
    ConfigError(format!(
        "invalid runtime specification {} at /{} ({})",
        crate::SPEC_VERSION,
        path.join("/"),
        error.kind().keyword()
    ))
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
