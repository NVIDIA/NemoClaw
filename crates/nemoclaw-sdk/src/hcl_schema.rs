// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! OpenTofu attribute shapes derived from a JSON schema, with snake_case names.
//!
//! The JSON schema keeps its value constraints; these shapes carry only what
//! OpenTofu can type-check. A schema construct without an OpenTofu equivalent
//! is an error, so a contract change cannot silently drop an input.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The OpenTofu type of one attribute.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Shape {
    String,
    Number,
    Bool,
    List(Box<Shape>),
    /// A map with arbitrary string keys, which keep their JSON spelling.
    Map(Box<Shape>),
    /// A single nested object.
    Object(Fields),
    /// A list of nested objects.
    ObjectList(Fields),
}

/// One nested attribute and the JSON property it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub json: String,
    pub shape: Shape,
    pub required: bool,
    pub description: String,
}

/// Attributes by OpenTofu name.
pub type Fields = BTreeMap<String, Field>;

/// A JSON schema location whose construct has no OpenTofu equivalent.
#[derive(Debug, PartialEq, Eq)]
pub struct Unmappable {
    pub pointer: String,
    pub reason: &'static str,
}

impl std::fmt::Display for Unmappable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} at {}", self.reason, self.pointer)
    }
}

/// The OpenTofu name for a camelCase JSON property: `gpuMemoryGiB` becomes
/// `gpu_memory_gib`.
pub fn hcl_name(json: &str) -> String {
    let json = json.replace("GiB", "Gib");
    let mut name = String::new();
    let mut previous: Option<char> = None;
    for character in json.chars() {
        if character.is_ascii_uppercase()
            && previous
                .is_some_and(|previous| previous.is_ascii_lowercase() || previous.is_ascii_digit())
        {
            name.push('_');
        }
        name.push(character.to_ascii_lowercase());
        previous = Some(character);
    }
    name
}

/// Attributes of a root object schema, omitting `excluded` properties.
pub fn fields(root: &Value, excluded: &[&str]) -> Result<Fields, Unmappable> {
    let mut fields = object_fields(root, root, "")?;
    fields.retain(|_, field| !excluded.contains(&field.json.as_str()));
    Ok(fields)
}

fn unmappable(pointer: &str, reason: &'static str) -> Unmappable {
    Unmappable {
        pointer: if pointer.is_empty() {
            "/".into()
        } else {
            pointer.into()
        },
        reason,
    }
}

fn resolve<'a>(root: &'a Value, schema: &'a Value, pointer: &str) -> Result<&'a Value, Unmappable> {
    match schema.get("$ref").and_then(Value::as_str) {
        Some(reference) => reference
            .strip_prefix('#')
            .and_then(|path| root.pointer(path))
            .ok_or_else(|| unmappable(pointer, "unresolvable reference"))
            .and_then(|target| resolve(root, target, pointer)),
        None => Ok(schema),
    }
}

fn variants(schema: &Value) -> Option<&Vec<Value>> {
    schema
        .get("anyOf")
        .or_else(|| schema.get("oneOf"))
        .and_then(Value::as_array)
}

fn is_object(schema: &Value) -> bool {
    schema.get("type").and_then(Value::as_str) == Some("object")
        || schema.get("properties").is_some()
}

fn shape(root: &Value, schema: &Value, pointer: &str) -> Result<Shape, Unmappable> {
    let schema = resolve(root, schema, pointer)?;
    if schema.get("type").is_none()
        && let Some(variants) = variants(schema)
    {
        let resolved = variants
            .iter()
            .map(|variant| resolve(root, variant, pointer))
            .collect::<Result<Vec<_>, _>>()?;
        if resolved.iter().all(|variant| is_object(variant)) {
            return merged(root, &resolved, pointer).map(Shape::Object);
        }
        return Err(unmappable(pointer, "union of non-object types"));
    }
    let kind = match schema.get("type") {
        Some(Value::String(kind)) => kind.as_str(),
        Some(_) => return Err(unmappable(pointer, "multiple types")),
        None if schema.get("enum").is_some_and(|values| {
            values
                .as_array()
                .is_some_and(|values| values.iter().all(Value::is_string))
        }) || schema.get("const").is_some_and(Value::is_string) =>
        {
            "string"
        }
        None => return Err(unmappable(pointer, "untyped schema")),
    };
    Ok(match kind {
        "string" => Shape::String,
        "integer" | "number" => Shape::Number,
        "boolean" => Shape::Bool,
        "array" => {
            let items = schema
                .get("items")
                .ok_or_else(|| unmappable(pointer, "array without item schema"))?;
            let pointer = format!("{pointer}/items");
            match shape(root, items, &pointer)? {
                Shape::Object(fields) => Shape::ObjectList(fields),
                Shape::ObjectList(_) => return Err(unmappable(&pointer, "nested object lists")),
                item => Shape::List(Box::new(item)),
            }
        }
        "object" => match schema.get("additionalProperties") {
            // Declared properties of a map only constrain its keys and values.
            Some(values) if values.is_object() => {
                let pointer = format!("{pointer}/additionalProperties");
                match shape(root, values, &pointer)? {
                    Shape::Object(_) | Shape::ObjectList(_) => {
                        return Err(unmappable(&pointer, "map of objects"));
                    }
                    item => Shape::Map(Box::new(item)),
                }
            }
            _ => Shape::Object(object_fields(root, schema, pointer)?),
        },
        _ => return Err(unmappable(pointer, "unsupported type")),
    })
}

fn object_fields(root: &Value, schema: &Value, pointer: &str) -> Result<Fields, Unmappable> {
    let schema = resolve(root, schema, pointer)?;
    let empty = Map::new();
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let mut fields = Fields::new();
    for (json, property) in properties {
        let pointer = format!("{pointer}/properties/{json}");
        let field = Field {
            json: json.clone(),
            shape: shape(root, property, &pointer)?,
            required: required.contains(&json.as_str()),
            description: description(root, property),
        };
        if fields.insert(hcl_name(json), field).is_some() {
            return Err(unmappable(&pointer, "duplicate OpenTofu name"));
        }
    }
    Ok(fields)
}

fn description(root: &Value, schema: &Value) -> String {
    schema
        .get("description")
        .or_else(|| resolve(root, schema, "").ok()?.get("description"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .into()
}

/// Alternative objects become one object whose properties are all optional;
/// the JSON schema still decides which combinations are valid.
fn merged(root: &Value, variants: &[&Value], pointer: &str) -> Result<Fields, Unmappable> {
    let mut fields = Fields::new();
    for variant in variants {
        for (name, mut field) in object_fields(root, variant, pointer)? {
            field.required = false;
            match fields.get(&name) {
                Some(existing) if existing.shape != field.shape => {
                    return Err(unmappable(pointer, "conflicting alternative properties"));
                }
                Some(_) => {}
                None => {
                    fields.insert(name, field);
                }
            }
        }
    }
    Ok(fields)
}

/// JSON with OpenTofu attribute names, for a configuration block.
pub fn to_hcl(fields: &Fields, value: &Value) -> Value {
    convert(&Shape::Object(fields.clone()), value, true)
}

/// JSON with schema property names; absent optional attributes arrive as null
/// from OpenTofu and are removed.
pub fn from_hcl(fields: &Fields, value: &Value) -> Value {
    convert(&Shape::Object(fields.clone()), value, false)
}

fn convert(shape: &Shape, value: &Value, outward: bool) -> Value {
    match (shape, value) {
        (Shape::Object(fields), Value::Object(object)) => Value::Object(
            object
                .iter()
                .filter_map(|(key, value)| {
                    let (name, field) = if outward {
                        fields
                            .iter()
                            .find(|(_, field)| field.json == *key)
                            .map(|(name, field)| (name.clone(), field))?
                    } else {
                        fields.get(key).map(|field| (field.json.clone(), field))?
                    };
                    // OpenTofu sends an omitted attribute or block as null and
                    // an omitted list block as an empty list.
                    let omitted = value.is_null()
                        || (!field.required
                            && matches!(field.shape, Shape::ObjectList(_))
                            && value.as_array().is_some_and(Vec::is_empty));
                    if !outward && omitted {
                        return None;
                    }
                    Some((name, convert(&field.shape, value, outward)))
                })
                .collect(),
        ),
        (Shape::ObjectList(fields), Value::Array(items)) => Value::Array(
            items
                .iter()
                .map(|item| convert(&Shape::Object(fields.clone()), item, outward))
                .collect(),
        ),
        (Shape::List(item), Value::Array(items)) => Value::Array(
            items
                .iter()
                .map(|value| convert(item, value, outward))
                .collect(),
        ),
        (Shape::Map(item), Value::Object(entries)) => Value::Object(
            entries
                .iter()
                .filter(|(_, value)| outward || !value.is_null())
                .map(|(key, value)| (key.clone(), convert(item, value, outward)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_follow_opentofu_conventions() {
        for (json, hcl) in [
            ("model", "model"),
            ("modelName", "model_name"),
            ("gpuMemoryGiB", "gpu_memory_gib"),
            ("minGpuMemoryBytes", "min_gpu_memory_bytes"),
            ("apiVersion", "api_version"),
            ("sha256", "sha256"),
        ] {
            assert_eq!(hcl_name(json), hcl);
        }
    }

    #[test]
    fn objects_maps_lists_and_alternatives_map_to_opentofu_shapes() {
        let root = json!({
            "type": "object",
            "required": ["model"],
            "properties": {
                "kind": {"const": "vllm", "type": "string"},
                "model": {"$ref": "#/$defs/Model"},
                "hardware": {"anyOf": [
                    {"type": "object", "properties": {"profile": {"enum": ["a"], "type": "string"}}},
                    {"type": "object", "properties": {"minDriverMajor": {"type": "integer"}}}
                ]},
                "labels": {"type": "object", "additionalProperties": {"type": "string"}},
                "files": {"type": "array", "items": {"$ref": "#/$defs/Model"}},
                "sizes": {"type": "array", "items": {"type": "integer"}},
                "port": {"anyOf": [{"minimum": 1}], "type": "integer"}
            },
            "$defs": {"Model": {"type": "object", "required": ["repository"], "properties": {
                "repository": {"type": "string"}, "gpuMemoryGiB": {"type": "number"}
            }}}
        });
        let fields = fields(&root, &["kind"]).unwrap();
        assert!(!fields.contains_key("kind"));
        assert!(fields["model"].required);
        let Shape::Object(model) = &fields["model"].shape else {
            panic!("model is an object")
        };
        assert!(model["repository"].required);
        assert_eq!(model["gpu_memory_gib"].shape, Shape::Number);
        let Shape::Object(hardware) = &fields["hardware"].shape else {
            panic!("alternatives merge")
        };
        assert!(!hardware["profile"].required && !hardware["min_driver_major"].required);
        assert_eq!(fields["labels"].shape, Shape::Map(Box::new(Shape::String)));
        assert!(matches!(fields["files"].shape, Shape::ObjectList(_)));
        assert_eq!(fields["sizes"].shape, Shape::List(Box::new(Shape::Number)));
        assert_eq!(fields["port"].shape, Shape::Number);

        let value = json!({"model": {"repository": "a/b", "gpuMemoryGiB": 2}, "labels": {"orgKey": "v"}, "files": [{"repository": "c/d"}]});
        let hcl = to_hcl(&fields, &value);
        assert_eq!(
            hcl,
            json!({"model": {"repository": "a/b", "gpu_memory_gib": 2}, "labels": {"orgKey": "v"}, "files": [{"repository": "c/d"}]})
        );
        let mut configured = hcl.clone();
        configured["hardware"] = Value::Null;
        configured["model"]["gpu_memory_gib"] = Value::Null;
        let mut expected = value;
        expected["model"]
            .as_object_mut()
            .unwrap()
            .remove("gpuMemoryGiB");
        assert_eq!(from_hcl(&fields, &configured), expected);
    }

    #[test]
    fn constructs_without_an_opentofu_type_are_errors() {
        for (property, reason) in [
            (
                json!({"anyOf": [{"type": "string"}, {"type": "object"}]}),
                "union of non-object types",
            ),
            (json!({"type": ["string", "integer"]}), "multiple types"),
            (json!({"type": "array"}), "array without item schema"),
            (json!({}), "untyped schema"),
        ] {
            let root = json!({"type": "object", "properties": {"value": property}});
            assert_eq!(fields(&root, &[]).unwrap_err().reason, reason);
        }
    }
}
