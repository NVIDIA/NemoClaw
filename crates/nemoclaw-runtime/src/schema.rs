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
/// Accepted values of a defaulted integer: its range, and zero before defaults apply.
pub fn bounds(min: i64, max: i64, normalized: bool) -> Value {
    if normalized {
        json!([{ "minimum": min, "maximum": max }])
    } else {
        json!([{ "const": 0 }, { "minimum": min, "maximum": max }])
    }
}
pub fn integer(schema: &mut Value, field: &str, rule: &DefaultedInteger, normalized: bool) {
    property(
        schema,
        field,
        json!({
            "anyOf": bounds(rule.min, rule.max, normalized),
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
// A `*` segment applies the rest of the path to every value of a map.
pub fn at(path: &str, rule: Value, required: bool) -> Value {
    path.split('/').rev().fold(rule, |child, segment| {
        if segment == "*" {
            json!({"additionalProperties": child})
        } else if required {
            json!({"required": [segment], "properties": {segment: child}})
        } else {
            json!({"properties": {segment: child}})
        }
    })
}

pub const MODEL: &str = r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$";
fn build() -> Value {
    let mut root = schemars::schema_for!(crate::RuntimeSpec).to_value();
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
    Some(segments(innermost(&SCHEMA, &error)))
}

/// The `oneOf` or `anyOf` variant that an instance names, so a diagnostic can
/// describe that variant's fields instead of the whole union: a `kind` or
/// `management` constant, the one key of an externally tagged variant that
/// the instance contains, or a hardware `profile`.
pub fn select_variant(variants: &[Value], instance: &Value) -> Option<usize> {
    for tag in ["kind", "management"] {
        if let Some(value) = instance.get(tag)
            && let Some(index) = variants
                .iter()
                .position(|variant| variant["properties"][tag].get("const") == Some(value))
        {
            return Some(index);
        }
    }
    // Several present keys name no single variant.
    let mut named = variants
        .iter()
        .enumerate()
        .filter(|(_, variant)| single_key(variant).is_some_and(|key| instance.get(key).is_some()));
    if let (Some((index, _)), None) = (named.next(), named.next()) {
        return Some(index);
    }
    variants.iter().position(|variant| {
        variant["properties"].get("profile").is_some() && instance.get("profile").is_some()
    })
}

/// The declared keys of an externally tagged union, when every variant is a
/// single-key object. They are schema names, never input, so diagnostics may
/// show them.
pub fn variant_keys(variants: &[Value]) -> Option<Vec<&str>> {
    let keys = variants
        .iter()
        .map(single_key)
        .collect::<Option<Vec<_>>>()?;
    (!keys.is_empty()).then_some(keys)
}

// An externally tagged variant is a closed object with one required property.
// Exclusive forms that only forbid their alternatives do not qualify.
fn single_key(variant: &Value) -> Option<&str> {
    let [key] = variant.get("required")?.as_array()?.as_slice() else {
        return None;
    };
    let key = key.as_str()?;
    let properties = variant.get("properties")?.as_object()?;
    (variant.get("additionalProperties") == Some(&Value::Bool(false))
        && properties.len() == 1
        && properties.contains_key(key))
    .then_some(key)
}

// Report the failing variant that the instance selected, not the union.
fn innermost<'e, 'a>(
    schema: &Value,
    error: &'e jsonschema::ValidationError<'a>,
) -> &'e jsonschema::ValidationError<'a> {
    use jsonschema::error::ValidationErrorKind as Kind;
    if let Kind::OneOfNotValid { context } | Kind::AnyOf { context } = error.kind()
        && let Some(variants) = schema
            .pointer(error.schema_path().as_str())
            .and_then(Value::as_array)
        && let Some(errors) =
            select_variant(variants, error.instance()).and_then(|index| context.get(index))
        && let Some(error) = errors.first()
    {
        return innermost(schema, error);
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
    let error = innermost(&SCHEMA, error);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn keyed(key: &str, schema: Value) -> Value {
        json!({"type": "object", "properties": {key: schema}, "required": [key], "additionalProperties": false})
    }

    fn targets() -> Vec<Value> {
        vec![
            keyed("docker", json!({"type": "object"})),
            keyed("podman", json!({"type": "object"})),
            keyed("kubernetes", json!({"$ref": "#/$defs/Cluster"})),
        ]
    }

    #[test]
    fn a_kind_or_management_constant_selects_its_variant() {
        let variants = [
            json!({"properties": {"management": {"const": "managed"}}}),
            json!({"properties": {"management": {"const": "external"}}}),
        ];
        assert_eq!(
            select_variant(&variants, &json!({"management": "external"})),
            Some(1)
        );
        assert_eq!(
            select_variant(&variants, &json!({"management": "other"})),
            None
        );
    }

    #[test]
    fn the_one_key_present_selects_its_single_key_variant() {
        let variants = targets();
        assert_eq!(select_variant(&variants, &json!({"podman": {}})), Some(1));
        // An unknown field beside the key still selects the named variant.
        assert_eq!(
            select_variant(&variants, &json!({"kubernetes": 1, "extra": {}})),
            Some(2)
        );
    }

    #[test]
    fn a_missing_doubled_or_unknown_key_selects_no_variant() {
        let variants = targets();
        for instance in [
            json!({}),
            json!({"docker": {}, "podman": {}}),
            json!({"dokcer": {}}),
            json!("docker"),
        ] {
            assert_eq!(select_variant(&variants, &instance), None, "{instance}");
        }
    }

    #[test]
    fn exclusive_forms_that_do_not_close_their_object_are_not_keyed_variants() {
        let variants = [
            json!({"required": ["inference"], "not": {"required": ["inferenceRef"]}}),
            json!({"required": ["inferenceRef"], "not": {"required": ["inference"]}}),
        ];
        assert_eq!(select_variant(&variants, &json!({"inference": {}})), None);
    }

    #[test]
    fn open_variants_that_each_require_one_field_are_not_keyed_variants() {
        // Both fields may appear together, so neither one names a variant.
        let variants = [
            json!({"properties": {"host": {"minLength": 1}}, "required": ["host"]}),
            json!({"properties": {"allowed_ips": {"minItems": 1}}, "required": ["allowed_ips"]}),
        ];
        assert_eq!(select_variant(&variants, &json!({"host": ""})), None);
        assert_eq!(variant_keys(&variants), None);
    }

    #[test]
    fn a_violation_inside_a_keyed_variant_is_reported_at_its_field() {
        let schema = json!({
            "type": "object",
            "properties": {"target": {"oneOf": targets()}},
            "$defs": {"Cluster": {
                "type": "object",
                "properties": {"endpoint": {"type": "string"}},
                "required": ["endpoint"]
            }}
        });
        let validator = jsonschema::validator_for(&schema).unwrap();
        let instance = json!({"target": {"kubernetes": {"endpoint": 1}}});
        let error = validator.validate(&instance).unwrap_err();
        let error = innermost(&schema, &error);
        assert_eq!(
            error.instance_path().as_str(),
            "/target/kubernetes/endpoint"
        );
        assert_eq!(error.kind().keyword(), "type");
    }
}
