// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Field lookup and conservative conditional choices from the SDK input schema.

use std::sync::OnceLock;

use crate::fingerprint::sha256;
use nemoclaw_sdk::config::schema::input_schema;
use serde_json::{Value, json};

/// Find a field in the SDK input schema without maintaining a parallel list of
/// document constraints. A required constant shared by all `oneOf` branches
/// becomes a finite discriminator; other branch properties need a selected value.
pub(crate) fn sdk_field_schema(path: &str) -> Option<(Value, bool)> {
    sdk_field_schema_for(&Value::Null, path)
}

fn schema_root() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(input_schema)
}

pub(crate) fn sdk_schema_identity() -> String {
    static IDENTITY: OnceLock<String> = OnceLock::new();
    IDENTITY
        .get_or_init(|| {
            let schema = schema_root();
            let bytes = serde_json::to_vec(schema).expect("SDK input schema serializes");
            format!(
                "{} sha256:{}",
                schema["$id"].as_str().unwrap_or("unknown"),
                sha256(&bytes)
            )
        })
        .clone()
}

pub(crate) fn sdk_field_schema_for(values: &Value, path: &str) -> Option<(Value, bool)> {
    let root = schema_root();
    let mut node = root;
    let mut required = false;
    let mut current_path = String::new();
    let segments = path.strip_prefix('/')?.split('/').collect::<Vec<_>>();
    for (index, part) in segments.iter().enumerate() {
        node = follow_ref(root, node)?;
        let name = part.replace("~1", "/").replace("~0", "~");
        if let Some((discriminator, choices)) = sdk_discriminator(node) {
            if name == discriminator {
                if index + 1 != segments.len() {
                    return None;
                }
                let mut field = node["oneOf"][0]["properties"][&discriminator].clone();
                field.as_object_mut()?.remove("const");
                field["enum"] = json!(choices);
                field["$defs"] = root.get("$defs")?.clone();
                return Some((field, true));
            }
            node = sdk_selected_branch(node, values.pointer(&current_path)?)?;
        }
        if part.parse::<usize>().is_ok() {
            node = node.get("items")?;
            required = true;
        } else if let Some(property) = node
            .get("properties")
            .and_then(|properties| properties.get(&name))
        {
            required = node
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| item == &name));
            node = property;
        } else {
            node = node
                .get("additionalProperties")
                .filter(|schema| **schema != Value::Bool(false))?;
            required = true;
        }
        current_path.push('/');
        current_path.push_str(part);
    }
    let mut field = follow_ref(root, node)?.clone();
    if let Some(object) = field.as_object_mut() {
        object.insert("$defs".into(), root.get("$defs")?.clone());
    }
    Some((field, required))
}

/// A one-of discriminator exists only when every branch requires the same
/// property with a distinct constant value. The SDK schema owns the choices.
pub(crate) fn sdk_discriminator(schema: &Value) -> Option<(String, Vec<Value>)> {
    let branches = schema.get("oneOf")?.as_array()?;
    let first = branches.first()?;
    for (name, property) in first.get("properties")?.as_object()? {
        if property.get("const").is_none() {
            continue;
        }
        let mut choices = Vec::new();
        for branch in branches {
            if !branch
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| item == name))
            {
                break;
            }
            let Some(choice) = branch
                .get("properties")
                .and_then(|properties| properties.get(name))
                .and_then(|field| field.get("const"))
            else {
                break;
            };
            if choices.contains(choice) {
                break;
            }
            choices.push(choice.clone());
        }
        if choices.len() == branches.len() {
            return Some((name.clone(), choices));
        }
    }
    None
}

/// Recognize the SDK's two-form exclusive choice where each branch requires
/// one property and forbids the other. The properties remain SDK-owned.
pub(crate) fn sdk_exclusive_required_fields(schema: &Value) -> Option<Vec<String>> {
    fn direct(schema: &Value) -> Option<Vec<String>> {
        let branches = schema.get("oneOf")?.as_array()?;
        if branches.len() != 2 {
            return None;
        }
        let mut fields = Vec::new();
        for branch in branches {
            let required = branch.get("required")?.as_array()?;
            if required.len() != 1 {
                return None;
            }
            fields.push(required[0].as_str()?.to_owned());
        }
        if fields[0] == fields[1] {
            return None;
        }
        for (index, branch) in branches.iter().enumerate() {
            let forbidden = branch.get("not")?.get("required")?.as_array()?;
            if forbidden.len() != 1 || forbidden[0].as_str()? != fields[1 - index] {
                return None;
            }
        }
        fields.sort();
        Some(fields)
    }

    if let Some(fields) = direct(schema) {
        return Some(fields);
    }
    let mut found = schema.get("allOf")?.as_array()?.iter().filter_map(direct);
    let fields = found.next()?;
    found.next().is_none().then_some(fields)
}

pub(crate) fn sdk_selected_branch<'a>(schema: &'a Value, supplied: &Value) -> Option<&'a Value> {
    let (discriminator, _) = sdk_discriminator(schema)?;
    let selected = supplied.get(&discriminator)?;
    schema.get("oneOf")?.as_array()?.iter().find(|branch| {
        branch
            .get("properties")
            .and_then(|properties| properties.get(&discriminator))
            .and_then(|field| field.get("const"))
            == Some(selected)
    })
}

fn follow_ref<'a>(root: &'a Value, mut node: &'a Value) -> Option<&'a Value> {
    for _ in 0..16 {
        let Some(reference) = node.get("$ref").and_then(Value::as_str) else {
            return Some(node);
        };
        node = root.pointer(reference.strip_prefix('#')?)?;
    }
    None
}
