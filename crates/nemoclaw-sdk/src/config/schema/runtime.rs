// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Offline validators compiled once from the SDK contract, never from a deployment file.
use crate::config::{ConfigError, Document, RouteTuning};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, LazyLock, Mutex},
};

static INPUT_SCHEMA: LazyLock<Value> = LazyLock::new(super::input_schema);
static INPUT: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&INPUT_SCHEMA));
static NORMALIZED: LazyLock<Value> = LazyLock::new(|| super::build_schema(true));
static DOCUMENT: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&NORMALIZED));
static DEFINITIONS: LazyLock<Mutex<BTreeMap<String, Arc<jsonschema::Validator>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static TUNING: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    compile(&serde_json::to_value(schemars::schema_for!(RouteTuning)).expect("tuning schema"))
});

fn compile(schema: &Value) -> jsonschema::Validator {
    jsonschema::validator_for(schema).expect("SDK configuration schema must compile")
}

fn check(validator: &jsonschema::Validator, value: &Value) -> Result<(), ConfigError> {
    validator
        .validate(value)
        .map_err(|error| diagnostic(&error))
}

fn diagnostic(error: &jsonschema::ValidationError<'_>) -> ConfigError {
    use jsonschema::error::ValidationErrorKind as Kind;
    let path = error.schema_path().to_string();
    // Select the declared tagged variant, so errors describe its fields rather than
    // unrelated alternatives. Never render instance values or user-controlled map keys.
    if let Kind::OneOfNotValid { context } | Kind::AnyOf { context } = error.kind()
        && let Some(variants) = INPUT_SCHEMA.pointer(&path).and_then(Value::as_array)
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
                return diagnostic(error);
            }
        }
    }
    let parent = path
        .rsplit_once('/')
        .and_then(|(parent, _)| INPUT_SCHEMA.pointer(parent));
    if let Some(message) = parent.and_then(|s| s["x-nemoclaw-error"].as_str()) {
        return ConfigError::new(message);
    }
    let constraint = match error.kind() {
        Kind::Enum { options } => format!("allowed values: {options}"),
        Kind::Minimum { limit } => format!("minimum: {limit}"),
        Kind::Maximum { limit } => format!("maximum: {limit}"),
        Kind::Required { property } => format!("required field: {property}"),
        Kind::Pattern { pattern } => format!("required pattern: {pattern}"),
        _ => error.kind().keyword().to_owned(),
    };
    ConfigError(format!(
        "configuration violates schema at {path} ({constraint})"
    ))
}

fn value(value: &impl Serialize) -> Result<Value, ConfigError> {
    serde_json::to_value(value)
        .map_err(|_| ConfigError::new("cannot encode configuration for validation"))
}

pub(crate) fn validate_input(value: &Value) -> Result<(), ConfigError> {
    check(&INPUT, value)
}

pub(crate) fn validate_document(document: &Document) -> Result<(), ConfigError> {
    check(&DOCUMENT, &value(document)?)
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
    check(&validator, &value(object)?)
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
    check(&TUNING, &value(tuning)?)
}
