// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Offline validators compiled once from the SDK contract, never from a deployment file.
use crate::config::{ConfigError, Document, RouteTuning};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, LazyLock, Mutex},
};

static INPUT_SCHEMA: LazyLock<Value> = LazyLock::new(super::input_schema);
static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&INPUT_SCHEMA));
static NORMALIZED: LazyLock<Value> = LazyLock::new(|| super::build_schema(true));
static DOCUMENT: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&NORMALIZED));
static DEFINITIONS: LazyLock<Mutex<BTreeMap<String, Arc<jsonschema::Validator>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static TUNING_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::to_value(schemars::schema_for!(RouteTuning)).expect("tuning schema")
});
static TUNING: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&TUNING_SCHEMA));
static NAME: LazyLock<jsonschema::Validator> =
    LazyLock::new(|| compile(&INPUT_SCHEMA["$defs"]["Metadata"]["properties"]["name"]));
static FIELDS: LazyLock<BTreeSet<String>> = LazyLock::new(|| {
    fn collect(value: &Value, fields: &mut BTreeSet<String>) {
        if let Some(properties) = value["properties"].as_object() {
            fields.extend(properties.keys().cloned());
        }
        match value {
            Value::Object(object) => object.values().for_each(|value| collect(value, fields)),
            Value::Array(array) => array.iter().for_each(|value| collect(value, fields)),
            _ => {}
        }
    }
    let mut fields = BTreeSet::new();
    collect(&INPUT_SCHEMA, &mut fields);
    fields
});

fn compile(schema: &Value) -> jsonschema::Validator {
    jsonschema::validator_for(schema).expect("SDK configuration schema must compile")
}

fn check(
    validator: &jsonschema::Validator,
    value: &Value,
    schema: &Value,
    source: Option<&str>,
) -> Result<(), ConfigError> {
    validator
        .validate(value)
        .map_err(|error| diagnostic(&error, value, schema, source))
}

fn diagnostic(
    error: &jsonschema::ValidationError<'_>,
    root: &Value,
    schema: &Value,
    source: Option<&str>,
) -> ConfigError {
    use jsonschema::error::{TypeKind, ValidationErrorKind as Kind};
    let schema_path = error.schema_path().to_string();
    // Select the declared tagged variant, so errors describe its fields rather than
    // unrelated alternatives. Never render rejected values or arbitrary map keys.
    if let Kind::OneOfNotValid { context } | Kind::AnyOf { context } = error.kind()
        && let Some(variants) = schema.pointer(&schema_path).and_then(Value::as_array)
    {
        for (variant, errors) in variants.iter().zip(context) {
            let matches_tag = ["kind", "management"].iter().any(|tag| {
                variant["properties"][tag]
                    .get("const")
                    .is_some_and(|expected| error.instance().get(tag) == Some(expected))
            });
            let matches_profile = variant["properties"].get("profile").is_some()
                && error.instance().get("profile").is_some();
            if (matches_tag || matches_profile)
                && let Some(error) = errors.first()
            {
                return diagnostic(error, root, schema, source);
            }
        }
    }
    let parent = schema_path
        .rsplit_once('/')
        .and_then(|(parent, _)| schema.pointer(parent));
    let constraint = if let Some(message) = parent.and_then(|s| s["x-nemoclaw-error"].as_str()) {
        message.to_owned()
    } else {
        match error.kind() {
            Kind::Enum { options } => format!("allowed values: {options}"),
            Kind::Constant { expected_value } => format!("must be {expected_value}"),
            Kind::Minimum { limit } => format!("must be at least {limit}"),
            Kind::Maximum { limit } => format!("must be at most {limit}"),
            Kind::Required { property } => format!("required field: {property}"),
            Kind::Pattern { pattern } => format!("required pattern: {pattern}"),
            Kind::Type {
                kind: TypeKind::Single(kind),
            } => format!("must be {kind}"),
            Kind::Type {
                kind: TypeKind::Multiple(kinds),
            } => format!(
                "must be {}",
                kinds
                    .iter()
                    .map(|kind| kind.to_string())
                    .collect::<Vec<_>>()
                    .join(" or ")
            ),
            Kind::AnyOf { .. } => schema
                .pointer(&schema_path)
                .and_then(Value::as_array)
                .and_then(|variants| {
                    variants
                        .iter()
                        .map(scalar_constraint)
                        .collect::<Option<Vec<_>>>()
                })
                .map(|alternatives| format!("must be {}", alternatives.join(" or ")))
                .unwrap_or_else(|| "must match an allowed combination of fields".into()),
            Kind::OneOfNotValid { .. } => "must match one allowed object shape".into(),
            Kind::AdditionalProperties { .. } => "unknown fields are not allowed".into(),
            _ => error.kind().keyword().to_owned(),
        }
    };
    let pointer = error.instance_path().to_string();
    let path = instance_path(&pointer, root);
    let position = source
        .and_then(|text| super::super::yaml_source::position(text, &pointer))
        .map(|(line, column)| format!(" (line {line}, column {column})"))
        .unwrap_or_default();
    ConfigError(format!(
        "configuration violates schema at {path}{position}: {constraint}"
    ))
}

fn scalar_constraint(schema: &Value) -> Option<String> {
    if let Some(value) = schema.get("const") {
        return Some(value.to_string());
    }
    match (schema.get("minimum"), schema.get("maximum")) {
        (Some(minimum), Some(maximum)) => Some(format!("between {minimum} and {maximum}")),
        (Some(minimum), None) => Some(format!("at least {minimum}")),
        (None, Some(maximum)) => Some(format!("at most {maximum}")),
        _ => None,
    }
}

fn instance_path(pointer: &str, root: &Value) -> String {
    if pointer.is_empty() {
        return "document root".into();
    }
    let mut path = String::new();
    let mut current = root;
    let parts: Vec<_> = pointer
        .split('/')
        .skip(1)
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect();
    for (offset, key) in parts.iter().enumerate() {
        if current.is_array()
            && let Ok(index) = key.parse::<usize>()
        {
            path.push_str(&format!("[{index}]"));
            current = &current[index];
        } else {
            // Only names in declared application collections can be shown. Invalid
            // names and opaque map keys remain hidden even if they resemble values.
            let named = match parts[..offset]
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                .as_slice()
            {
                [
                    "spec",
                    "services" | "harnesses" | "inferences" | "integrations",
                ] => true,
                [
                    "spec",
                    "sandboxes",
                    index,
                    "harnesses" | "inferences" | "integrations",
                ]
                | ["spec", "sandboxes", index, "agent", "integrations"] => {
                    index.parse::<usize>().is_ok()
                }
                _ => false,
            };
            let visible = if named {
                NAME.is_valid(&Value::String(key.clone()))
            } else {
                FIELDS.contains(key)
            };
            if !path.is_empty() {
                path.push('.');
            }
            path.push_str(if visible { key } else { "[entry]" });
            current = &current[key];
        }
    }
    path
}

fn value(value: &impl Serialize) -> Result<Value, ConfigError> {
    serde_json::to_value(value)
        .map_err(|_| ConfigError::new("cannot encode configuration for validation"))
}

pub(crate) fn validate_input(value: &Value, source: Option<&str>) -> Result<(), ConfigError> {
    check(&INPUT, value, &INPUT_SCHEMA, source)
}

pub(crate) fn validate_document(document: &Document) -> Result<(), ConfigError> {
    check(&DOCUMENT, &value(document)?, &NORMALIZED, None)
}

pub(crate) fn validate_definition(
    name: &'static str,
    object: &impl Serialize,
) -> Result<(), ConfigError> {
    validate_at(&format!("/$defs/{name}"), object)
}

pub(crate) fn validate_property(
    definition: &'static str,
    field: &'static str,
    object: &impl Serialize,
) -> Result<(), ConfigError> {
    validate_at(&format!("/$defs/{definition}/properties/{field}"), object)
}

fn validate_at(path: &str, object: &impl Serialize) -> Result<(), ConfigError> {
    let validator = {
        let mut cache = DEFINITIONS.lock().expect("schema validator cache");
        cache
            .entry(path.to_owned())
            .or_insert_with(|| {
                assert!(
                    NORMALIZED.pointer(path).is_some(),
                    "unknown schema path: {path}"
                );
                Arc::new(compile(&json!({
                    "$schema": NORMALIZED["$schema"],
                    "$defs": NORMALIZED["$defs"],
                    "$ref": format!("#{path}")
                })))
            })
            .clone()
    };
    check(&validator, &value(object)?, &NORMALIZED, None)
}

pub(crate) fn validate_service(
    kind: &'static str,
    service: &impl Serialize,
) -> Result<(), ConfigError> {
    let mut object = value(service)?;
    object["kind"] = json!(kind);
    validate_definition("ServiceDefinition", &object)
}

pub(crate) fn validate_tuning(tuning: &RouteTuning) -> Result<(), ConfigError> {
    check(&TUNING, &value(tuning)?, &TUNING_SCHEMA, None)
}
