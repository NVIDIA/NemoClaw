// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Offline validators compiled once from the SDK contract, never from a deployment file.
use crate::config::{ConfigError, Document, RouteTuning};
use nemoclaw_runtime::schema::{select_variant, variant_keys};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, LazyLock, Mutex},
};

static INPUT: LazyLock<jsonschema::Validator> =
    LazyLock::new(|| compile(super::input_schema_ref()));
static NORMALIZED: LazyLock<Value> = LazyLock::new(|| super::build_schema(true));
static DOCUMENT: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&NORMALIZED));
// Validators for one location reference the normalized schema in one prepared
// registry, as jsonschema suggests for checking against one definition:
// compiling each from a copy of the schema costs more than the checks it serves.
static NORMALIZED_SCHEMA: LazyLock<jsonschema::Registry<'static>> = LazyLock::new(|| {
    jsonschema::Registry::new()
        .add(normalized_id(), NORMALIZED.clone())
        .and_then(|registry| registry.prepare())
        .expect("SDK configuration schema must register")
});
static DEFINITIONS: LazyLock<Mutex<BTreeMap<String, Arc<jsonschema::Validator>>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static TUNING_SCHEMA: LazyLock<Value> =
    LazyLock::new(|| schemars::schema_for!(RouteTuning).to_value());
static TUNING: LazyLock<jsonschema::Validator> = LazyLock::new(|| compile(&TUNING_SCHEMA));
static NAME: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    compile(&super::input_schema_ref()["$defs"]["Metadata"]["properties"]["name"])
});
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
    collect(super::input_schema_ref(), &mut fields);
    fields
});

pub(super) fn input_validator() -> &'static jsonschema::Validator {
    &INPUT
}

fn normalized_id() -> &'static str {
    NORMALIZED["$id"]
        .as_str()
        .expect("SDK configuration schema has an $id")
}

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
        .map_err(|error| diagnostic(&error, value, schema, source, ""))
}

/// `variant` is the schema location of the union variant that the input
/// selected on the way to this error, or empty when it selected none.
fn diagnostic(
    error: &jsonschema::ValidationError<'_>,
    root: &Value,
    schema: &Value,
    source: Option<&str>,
    variant: &str,
) -> ConfigError {
    use jsonschema::error::{TypeKind, ValidationErrorKind as Kind};
    let schema_path = error.schema_path().as_str();
    let union = match error.kind() {
        Kind::OneOfNotValid { context } | Kind::AnyOf { context } => schema
            .pointer(schema_path)
            .and_then(Value::as_array)
            .map(|variants| (variants, context)),
        _ => None,
    };
    // Select the variant the input names, so errors describe its fields rather than
    // unrelated alternatives. Never render rejected values or arbitrary map keys.
    if let Some((variants, context)) = union
        && let Some(index) = select_variant(variants, error.instance())
        && let Some(error) = context.get(index).and_then(|errors| errors.first())
    {
        let variant = format!("{schema_path}/{index}");
        return diagnostic(error, root, schema, source, &variant);
    }
    let pointer = error.instance_path().to_string();
    // A tag such as `kind` that names no variant: list the values the variants
    // declare, never the input's.
    if let Some((variants, _)) = union
        && let Some((tag, values)) = tag_values(variants)
        && let Some(object) = error.instance().as_object()
        && object
            .get(tag)
            .is_none_or(|value| values.iter().all(|known| value.as_str() != Some(known)))
    {
        let values = values.join(", ");
        return match object.get(tag) {
            Some(_) => located(
                root,
                source,
                &format!("{pointer}/{tag}"),
                None,
                &format!("must be one of: {values}"),
            ),
            None => located(
                root,
                source,
                &pointer,
                None,
                &format!("required field: \"{tag}\"; must be one of: {values}"),
            ),
        };
    }
    // An unknown field or an invalid map key is located at the key, which the
    // message never shows.
    let key = match error.kind() {
        Kind::AdditionalProperties { unexpected } => first_written(unexpected, &pointer, source),
        Kind::PropertyNames { error } => error.instance().as_str().map(str::to_owned),
        _ => None,
    };
    let keyed = union.and_then(|(variants, _)| variant_keys(variants));
    let constraint = if let Some(mut keys) = keyed {
        // The input named no single variant: list the declared keys, never the
        // input's, unless the union carries its own message. An enclosing
        // rule's message describes a different constraint.
        let own = schema_path
            .rsplit_once('/')
            .and_then(|(union, _)| schema.pointer(union)?.get("x-nemoclaw-error")?.as_str());
        own.map(str::to_owned).unwrap_or_else(|| {
            keys.sort_unstable();
            format!("must contain exactly one of: {}", keys.join(", "))
        })
    } else if let Some(message) = annotation(schema, error, variant) {
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
            Kind::AnyOf { .. } => union
                .and_then(|(variants, _)| {
                    variants
                        .iter()
                        .map(scalar_constraint)
                        .collect::<Option<Vec<_>>>()
                })
                .map(|alternatives| format!("must be {}", alternatives.join(" or ")))
                .unwrap_or_else(|| "must match an allowed combination of fields".into()),
            Kind::OneOfNotValid { .. } => "must match one allowed object shape".into(),
            Kind::OneOfMultipleValid { .. } => "must match exactly one allowed object shape".into(),
            Kind::AdditionalProperties { .. } | Kind::UnevaluatedProperties { .. } => {
                unknown_field(key.as_deref(), &declared_fields(schema, schema_path))
            }
            Kind::MinLength { limit: 1 }
            | Kind::MinItems { limit: 1 }
            | Kind::MinProperties { limit: 1 } => "must not be empty".into(),
            Kind::MinLength { limit } => format!("must have at least {limit} characters"),
            Kind::MaxLength { limit } => format!("must have at most {limit} characters"),
            Kind::MinItems { limit } | Kind::MinProperties { limit } => {
                format!("must have at least {limit} entries")
            }
            Kind::MaxItems { limit } | Kind::MaxProperties { limit } => {
                format!("must have at most {limit} entries")
            }
            Kind::UniqueItems => "must not repeat an entry".into(),
            Kind::Not { schema } => {
                negation(schema).unwrap_or_else(|| "must not take an excluded form".into())
            }
            Kind::PropertyNames { error } => match error.kind() {
                Kind::Pattern { pattern } => format!("names must match the pattern {pattern}"),
                Kind::Not { schema } => negation(schema).map_or_else(
                    || "names must not take an excluded form".into(),
                    |excluded| format!("names {excluded}"),
                ),
                _ => "names must be valid".into(),
            },
            Kind::ExclusiveMinimum { limit } => format!("must be greater than {limit}"),
            Kind::ExclusiveMaximum { limit } => format!("must be less than {limit}"),
            Kind::MultipleOf { multiple_of } => format!("must be a multiple of {multiple_of}"),
            Kind::Contains => "must contain a matching entry".into(),
            Kind::FalseSchema => "is not allowed here".into(),
            _ => "does not match the configuration schema".into(),
        }
    };
    located(root, source, &pointer, key.as_deref(), &constraint)
}

/// The error at `pointer`, positioned at the map key `key` when the failure is
/// about that key. The key itself is never shown.
fn located(
    root: &Value,
    source: Option<&str>,
    pointer: &str,
    key: Option<&str>,
    constraint: &str,
) -> ConfigError {
    use super::super::yaml_source;
    let path = instance_path(pointer, root);
    let position = source
        .and_then(|text| match key {
            Some(key) => yaml_source::key_position(text, &format!("{pointer}/{}", escape(key))),
            None => yaml_source::position(text, pointer),
        })
        .map(|(line, column)| format!(" (line {line}, column {column})"))
        .unwrap_or_default();
    ConfigError(format!(
        "configuration violates schema at {path}{position}: {constraint}"
    ))
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// The tag every variant of a union declares as a constant, with its values.
fn tag_values(variants: &[Value]) -> Option<(&'static str, Vec<String>)> {
    nemoclaw_runtime::schema::UNION_TAGS
        .into_iter()
        .find_map(|tag| {
            let mut values = variants
                .iter()
                .map(|variant| {
                    variant["properties"][tag]["const"]
                        .as_str()
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()?;
            values.sort_unstable();
            values.dedup();
            Some((tag, values))
        })
}

/// Of several unknown keys, the one written first, so the position and the
/// hint describe the same field.
fn first_written(unexpected: &[String], pointer: &str, source: Option<&str>) -> Option<String> {
    unexpected
        .iter()
        .min_by_key(|key| {
            source
                .and_then(|text| {
                    super::super::yaml_source::key_position(
                        text,
                        &format!("{pointer}/{}", escape(key)),
                    )
                })
                .unwrap_or((usize::MAX, usize::MAX))
        })
        .cloned()
}

/// The fields declared by the object schema whose `additionalProperties`
/// rejected a key.
fn declared_fields<'s>(schema: &'s Value, schema_path: &str) -> Vec<&'s str> {
    schema_path
        .strip_suffix("/additionalProperties")
        .and_then(|object| schema.pointer(object)?.get("properties")?.as_object())
        .map(|properties| properties.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

/// Suggest the declared field closest to an unknown key, or list the fields of
/// a small object. Only schema names appear, never the key itself.
fn unknown_field(key: Option<&str>, declared: &[&str]) -> String {
    const LISTED_FIELDS: usize = 10;
    let nearest = key.and_then(|key| {
        declared
            .iter()
            .map(|name| (strsim::osa_distance(key, name), *name))
            .filter(|(distance, _)| *distance <= 2 && *distance < key.chars().count())
            .min()
    });
    match nearest {
        Some((_, name)) => format!("unknown fields are not allowed; did you mean \"{name}\"?"),
        None if !declared.is_empty() && declared.len() <= LISTED_FIELDS => format!(
            "unknown fields are not allowed; accepted fields: {}",
            declared.join(", ")
        ),
        None => "unknown fields are not allowed".into(),
    }
}

/// Describe a `not` rule that excludes fields or values, such as the rules
/// `forbid` builds, from the names and values in the schema.
fn negation(excluded: &Value) -> Option<String> {
    fn fields(required: &Value) -> Option<Vec<String>> {
        required
            .as_array()?
            .iter()
            .map(|name| name.as_str().map(str::to_owned))
            .collect()
    }
    fn listed(items: &[String], conjunction: &str) -> Option<String> {
        Some(match items {
            [] => return None,
            [only] => only.clone(),
            [first, second] => format!("{first} {conjunction} {second}"),
            [rest @ .., last] => format!("{}, {conjunction} {last}", rest.join(", ")),
        })
    }
    let object = excluded.as_object().filter(|object| object.len() == 1)?;
    let (keyword, value) = object.iter().next()?;
    Some(match keyword.as_str() {
        "required" => match fields(value)?.as_slice() {
            [] => return None,
            [only] => format!("must not set {only}"),
            [first, second] => format!("must not set both {first} and {second}"),
            names => format!("must not set all of {}", listed(names, "and")?),
        },
        "anyOf" => {
            let names = value
                .as_array()?
                .iter()
                .map(|branch| {
                    let branch = branch.as_object().filter(|branch| branch.len() == 1)?;
                    match fields(branch.get("required")?)?.as_slice() {
                        [only] => Some(only.clone()),
                        _ => None,
                    }
                })
                .collect::<Option<Vec<_>>>()?;
            format!("must not set {}", listed(&names, "or")?)
        }
        "enum" => {
            let values = value
                .as_array()?
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>();
            format!("must not be {}", listed(&values, "or")?)
        }
        "const" => format!("must not be {value}"),
        _ => return None,
    })
}

/// Schema locations of `not` rules whose failure no message describes: they
/// carry no `x-nemoclaw-error`, on themselves or on an enclosing node of their
/// definition, and exclude more than fields or values that `negation` can
/// name. Schema generation rejects them, so no error shows a bare keyword.
pub fn unexplained_rules(schema: &Value) -> Vec<String> {
    fn walk(node: &Value, path: &str, annotated: bool, found: &mut Vec<String>) {
        match node {
            Value::Object(object) => {
                let annotated = annotated || object.contains_key("x-nemoclaw-error");
                if let Some(excluded) = object.get("not")
                    && !annotated
                    && negation(excluded).is_none()
                {
                    found.push(format!("{path}/not"));
                }
                for (key, child) in object {
                    let path = format!("{path}/{}", escape(key));
                    let entries = || child.as_object().into_iter().flatten();
                    match key.as_str() {
                        // Values, not schemas.
                        "const" | "enum" | "default" | "examples" => {}
                        // Each definition is a message scope of its own, as for
                        // diagnostics, which never look above a definition.
                        "$defs" => {
                            for (name, definition) in entries() {
                                walk(
                                    definition,
                                    &format!("{path}/{}", escape(name)),
                                    false,
                                    found,
                                );
                            }
                        }
                        // Maps from field names, which may be keyword names, to schemas.
                        "properties" | "patternProperties" | "dependentSchemas" => {
                            for (name, property) in entries() {
                                let path = format!("{path}/{}", escape(name));
                                walk(property, &path, annotated, found);
                            }
                        }
                        _ => walk(child, &path, annotated, found),
                    }
                }
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    walk(item, &format!("{path}/{index}"), annotated, found);
                }
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    walk(schema, "", false, &mut found);
    found
}

/// The message of the nearest annotated schema node enclosing the failing
/// keyword, so a rule built from nested `properties`, `items`, `allOf`, or
/// `then` steps keeps its explanation. A missing field prefers its own
/// annotation. Canonical schema locations never cross `$ref`, so the walk ends
/// at a definition root; it also ends at the selected variant's root, so a
/// union's message cannot hide a more specific error inside that variant.
fn annotation<'s>(
    schema: &'s Value,
    error: &jsonschema::ValidationError<'_>,
    variant: &str,
) -> Option<&'s str> {
    use jsonschema::error::ValidationErrorKind as Kind;
    let message = |pointer: &str| schema.pointer(pointer)?.get("x-nemoclaw-error")?.as_str();
    let path = error.schema_path().as_str();
    if let Kind::Required { property } = error.kind()
        && let (Some(object), Some(name)) = (path.strip_suffix("/required"), property.as_str())
        && let Some(found) = message(&format!(
            "{object}/properties/{}",
            name.replace('~', "~0").replace('/', "~1")
        ))
    {
        return Some(found);
    }
    let floor = path
        .strip_prefix(variant)
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
        .map_or(0, |_| variant.len());
    let mut current = path;
    while let Some((parent, _)) = current.rsplit_once('/') {
        if parent.is_empty() || parent == "/$defs" || parent.len() < floor {
            break;
        }
        if let Some(found) = message(parent) {
            return Some(found);
        }
        current = parent;
    }
    None
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
            let named = matches!(
                parts[..offset]
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice(),
                [
                    "spec",
                    "services"
                        | "sandboxes"
                        | "harnesses"
                        | "inferences"
                        | "inferenceProviders"
                        | "integrations",
                ] | [
                    "spec",
                    "sandboxes",
                    _,
                    "harnesses" | "inferences" | "inferenceProviders" | "integrations",
                ] | ["spec", "sandboxes", _, "agent", "integrations"]
            );
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
    check(&INPUT, value, super::input_schema_ref(), source)
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
                Arc::new(
                    jsonschema::options()
                        .with_registry(&NORMALIZED_SCHEMA)
                        .build(&json!({"$ref": format!("{}#{path}", normalized_id())}))
                        .expect("SDK configuration schema must compile"),
                )
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

#[cfg(test)]
mod tests {
    use super::*;

    // Field names come from the SDK schema, so diagnostics may show them.
    fn keyed(key: &str, schema: Value) -> Value {
        json!({"type": "object", "properties": {key: schema}, "required": [key], "additionalProperties": false})
    }

    fn targets() -> Value {
        json!({
            "type": "object",
            "properties": {"gateway": {"$ref": "#/$defs/Target"}},
            "$defs": {
                "Target": {"oneOf": [
                    keyed("docker", json!({"$ref": "#/$defs/Local"})),
                    keyed("podman", json!({"$ref": "#/$defs/Local"})),
                    keyed("kubernetes", json!({"$ref": "#/$defs/Cluster"})),
                ]},
                "Local": {
                    "type": "object",
                    "properties": {"engine": {"type": "string", "minLength": 1}},
                    "additionalProperties": false
                },
                "Cluster": {
                    "type": "object",
                    "properties": {
                        "endpoint": {"type": "string", "pattern": "^https://"},
                        "namespace": {"type": "string"}
                    },
                    "required": ["endpoint"],
                    "additionalProperties": false
                }
            }
        })
    }

    fn message(schema: &Value, instance: Value) -> String {
        check(&compile(schema), &instance, schema, None)
            .unwrap_err()
            .to_string()
    }

    #[test]
    fn an_error_inside_the_named_single_key_variant_names_its_field() {
        let error = message(
            &targets(),
            json!({"gateway": {"kubernetes": {"endpoint": "http://127.0.0.1:1"}}}),
        );
        assert_eq!(
            error,
            "configuration violates schema at gateway.kubernetes.endpoint: required pattern: ^https://"
        );
        let error = message(&targets(), json!({"gateway": {"kubernetes": {}}}));
        assert_eq!(
            error,
            r#"configuration violates schema at gateway.kubernetes: required field: "endpoint""#
        );
    }

    #[test]
    fn a_single_key_union_without_one_known_key_lists_the_declared_keys() {
        for instance in [
            json!({"PRIVATE_SENTINEL": {}}),
            json!({}),
            json!({"docker": {}, "podman": {}}),
            json!("PRIVATE_SENTINEL"),
        ] {
            let error = message(&targets(), json!({"gateway": instance}));
            assert_eq!(
                error,
                "configuration violates schema at gateway: must contain exactly one of: docker, kubernetes, podman",
                "{instance}"
            );
        }
    }

    #[test]
    fn a_single_key_union_prefers_its_own_annotation_when_no_key_selects_a_variant() {
        let mut schema = targets();
        schema["$defs"]["Target"]["x-nemoclaw-error"] = json!("gateway must name one target");
        let error = message(&schema, json!({"gateway": {"dokcer": {}}}));
        assert_eq!(
            error,
            "configuration violates schema at gateway: gateway must name one target"
        );
        assert!(!error.contains("dokcer"), "{error}");
        // The union's message does not hide an error inside the selected variant.
        schema["$defs"]["Target"]["oneOf"][2]["properties"]["kubernetes"] =
            schema["$defs"]["Cluster"].clone();
        let error = message(&schema, json!({"gateway": {"kubernetes": {"endpoint": 1}}}));
        assert_eq!(
            error,
            "configuration violates schema at gateway.kubernetes.endpoint: must be string"
        );
    }

    #[test]
    fn an_inline_single_key_union_without_one_known_key_ignores_annotated_ancestors() {
        let union = |annotation: Option<&str>| {
            let mut runtime = json!({"oneOf": [
                keyed("docker", json!({"type": "object"})),
                keyed("podman", json!({"type": "object"})),
            ]});
            if let Some(annotation) = annotation {
                runtime["x-nemoclaw-error"] = json!(annotation);
            }
            json!({
                "type": "object",
                "properties": {"gateway": {
                    "type": "object",
                    "properties": {"runtime": runtime},
                    "x-nemoclaw-error": "the gateway must name an endpoint"
                }}
            })
        };
        for runtime in [json!({"dokcer": {}}), json!({})] {
            let instance = json!({"gateway": {"runtime": runtime}});
            assert_eq!(
                message(&union(None), instance.clone()),
                "configuration violates schema at gateway.runtime: must contain exactly one of: docker, podman",
                "{instance}"
            );
            assert_eq!(
                message(&union(Some("the gateway names one runtime")), instance),
                "configuration violates schema at gateway.runtime: the gateway names one runtime"
            );
        }
    }

    #[test]
    fn a_nested_rule_reports_the_nearest_enclosing_annotation() {
        let schema = json!({
            "type": "object",
            "properties": {"gateway": {
                "type": "object",
                "properties": {"environment": {
                    "type": "array",
                    "items": {"type": "string", "not": {"const": "PATH"}},
                    "x-nemoclaw-error": "environment names must not shadow process controls"
                }},
                "if": {"required": ["namespace"]},
                "then": {
                    "properties": {"endpoint": {"pattern": "^https://"}},
                    "allOf": [{"not": {"required": ["engine"]}}],
                    "x-nemoclaw-error": "a cluster target requires HTTPS and excludes engine"
                }
            }}
        });
        for (instance, path, expected) in [
            (
                json!({"environment": ["PATH"]}),
                "gateway.environment[0]",
                "environment names must not shadow process controls",
            ),
            (
                json!({"namespace": "agents", "endpoint": "http://127.0.0.1:1"}),
                "gateway.endpoint",
                "a cluster target requires HTTPS and excludes engine",
            ),
            (
                json!({"namespace": "agents", "engine": "unix:///run/engine.sock"}),
                "gateway",
                "a cluster target requires HTTPS and excludes engine",
            ),
        ] {
            assert_eq!(
                message(&schema, json!({"gateway": instance})),
                format!("configuration violates schema at {path}: {expected}")
            );
        }
    }

    #[test]
    fn a_missing_field_reports_its_own_annotation() {
        let schema = json!({
            "type": "object",
            "properties": {"gateway": {
                "type": "object",
                "properties": {
                    "engine": {"type": "string", "x-nemoclaw-error": "the engine names a local socket"},
                    "endpoint": {"type": "string"}
                },
                "required": ["engine", "endpoint"],
                "x-nemoclaw-error": "the gateway is incomplete"
            }}
        });
        assert_eq!(
            message(
                &schema,
                json!({"gateway": {"endpoint": "http://127.0.0.1:1"}})
            ),
            "configuration violates schema at gateway: the engine names a local socket"
        );
        assert_eq!(
            message(
                &schema,
                json!({"gateway": {"engine": "unix:///run/engine.sock"}})
            ),
            "configuration violates schema at gateway: the gateway is incomplete"
        );
    }

    #[test]
    fn a_rule_that_excludes_fields_or_values_names_them() {
        let schema = |rule: Value| json!({"type": "object", "properties": {"gateway": rule}});
        for (rule, instance, expected) in [
            (
                nemoclaw_runtime::schema::forbid(&["credential", "tls"]),
                json!({"tls": {}}),
                "must not set credential or tls",
            ),
            (
                json!({"not": {"required": ["policy", "policyRef"]}}),
                json!({"policy": {}, "policyRef": "shared"}),
                "must not set both policy and policyRef",
            ),
            (
                json!({"not": {"enum": ["dgx-spark", "rtx-spark"]}}),
                json!("dgx-spark"),
                r#"must not be "dgx-spark" or "rtx-spark""#,
            ),
        ] {
            assert_eq!(
                message(&schema(rule), json!({"gateway": instance})),
                format!("configuration violates schema at gateway: {expected}")
            );
        }
    }

    #[test]
    fn unexplained_rules_are_those_only_a_keyword_would_describe() {
        let schema = json!({
            "$defs": {
                "Annotated": {"not": {"pattern": "^x"}, "x-nemoclaw-error": "must not start with x"},
                "Enclosed": {
                    "x-nemoclaw-error": "an enclosing rule's message",
                    "properties": {"inner": {"not": {"pattern": "^x"}}}
                },
                "Forbidden": nemoclaw_runtime::schema::forbid(&["credential"]),
                "Named": {"not": {"pattern": "^x"}}
            },
            // A field may share a keyword's name.
            "properties": {"default": {"not": {"minLength": 3}}}
        });
        assert_eq!(
            unexplained_rules(&schema),
            ["/$defs/Named/not", "/properties/default/not"]
        );
        assert_eq!(
            unexplained_rules(super::super::input_schema_ref()),
            Vec::<String>::new(),
            "every SDK schema rule must explain its failure"
        );
    }
}
