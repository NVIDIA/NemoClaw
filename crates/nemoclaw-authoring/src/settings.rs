// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Diagnostics, diagnostics::diagnostic};
use nemoclaw_sdk::json_schema::schema_accepts;
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SettingQuestion {
    pub path: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub schema: Value,
    pub choices: Vec<Value>,
    pub suggestion: Option<Value>,
}

pub(crate) fn put(root: &mut Value, path: &str, value: Option<Value>) -> Result<(), Diagnostics> {
    if path.is_empty() {
        *root = value.unwrap_or_else(|| Value::Object(Map::new()));
        return Ok(());
    }

    let parts: Vec<_> = path
        .split('/')
        .skip(1)
        .map(|part| part.replace("~1", "/").replace("~0", "~"))
        .collect();
    let mut current = root;
    for part in &parts[..parts.len().saturating_sub(1)] {
        current = current
            .as_object_mut()
            .ok_or_else(|| diagnostic("settings", "Expected an object setting."))?
            .entry(part)
            .or_insert_with(|| Value::Object(Map::new()));
    }
    let key = parts
        .last()
        .ok_or_else(|| diagnostic("settings", "Invalid setting path."))?;
    let object = current
        .as_object_mut()
        .ok_or_else(|| diagnostic("settings", "Expected an object setting."))?;
    if let Some(value) = value {
        object.insert(key.clone(), value);
    } else {
        object.remove(key);
    }
    Ok(())
}
pub(crate) fn collect(
    root: &Value,
    schema: &Value,
    values: &Value,
    path: &str,
    required: bool,
    fields: &mut Vec<SettingQuestion>,
    depth: usize,
) -> Result<(), Diagnostics> {
    if depth > 32 || fields.len() > 256 {
        return Err(diagnostic(
            "settings",
            "Adapter schema exceeds supported interview depth or size.",
        ));
    }
    if let Some(reference) = schema["$ref"].as_str() {
        let resolved = reference
            .strip_prefix('#')
            .and_then(|reference| root.pointer(reference))
            .ok_or_else(|| {
                diagnostic("settings", "Adapter schema reference cannot be resolved.")
            })?;
        return collect(root, resolved, values, path, required, fields, depth + 1);
    }
    let mut effective = schema.clone();
    let mut branches = schema["allOf"].as_array().cloned().unwrap_or_default();
    if let Some(condition) = schema.get("if") {
        let branch = match schema_accepts(condition, values) {
            Some(true) => schema.get("then"),
            Some(false) => schema.get("else"),
            None => {
                return Err(diagnostic(
                    "settings",
                    "Conditional adapter schema could not be evaluated.",
                ));
            }
        };
        branches.extend(branch.cloned());
    }
    for keyword in ["oneOf", "anyOf"] {
        if let Some(alternatives) = schema[keyword].as_array() {
            let compatible: Vec<_> = alternatives
                .iter()
                .filter(|branch| {
                    if let Some(properties) = branch["properties"].as_object() {
                        !properties.iter().any(|(key, constraint)| {
                            values.get(key).is_some_and(|value| {
                                schema_accepts(constraint, value) == Some(false)
                            })
                        })
                    } else {
                        schema_accepts(branch, values) != Some(false)
                    }
                })
                .cloned()
                .collect();
            let valid = compatible
                .iter()
                .filter(|branch| schema_accepts(branch, values) == Some(true))
                .collect::<Vec<_>>();
            if compatible.len() == 1 {
                branches.extend(compatible);
            } else if valid.len() == 1 && schema_accepts(schema, values) == Some(true) {
                branches.push((*valid[0]).clone());
            } else if !path.is_empty() {
                // Ambiguous unions stay one typed JSON question; never guess a branch.
                fields.push(SettingQuestion {
                    path: path.into(),
                    title: schema["title"].as_str().map(Into::into),
                    description: Some(
                        schema["description"]
                            .as_str()
                            .unwrap_or("Enter a JSON value matching one advertised alternative.")
                            .into(),
                    ),
                    required,
                    schema: schema.clone(),
                    choices: Vec::new(),
                    suggestion: if schema_accepts(schema, values) == Some(true) {
                        Some(values.clone())
                    } else if required {
                        schema
                            .get("default")
                            .filter(|value| schema_accepts(schema, value) == Some(true))
                            .cloned()
                    } else {
                        None
                    },
                });
                return Ok(());
            } else if let Some(first) = compatible.first() {
                // Ask discriminators shared across alternatives before selecting a branch.
                let mut shared = Map::new();
                if let Some(properties) = first["properties"].as_object() {
                    for (name, constraint) in properties {
                        let alternatives: Vec<_> = compatible
                            .iter()
                            .filter_map(|branch| branch["properties"].get(name))
                            .collect();
                        if alternatives.len() == compatible.len() {
                            let mut choices = Vec::new();
                            for alternative in alternatives {
                                if let Some(value) = alternative.get("const")
                                    && !choices.contains(value)
                                {
                                    choices.push(value.clone());
                                }
                                if let Some(values) = alternative["enum"].as_array() {
                                    for value in values {
                                        if !choices.contains(value) {
                                            choices.push(value.clone());
                                        }
                                    }
                                }
                            }
                            if !choices.is_empty() {
                                let mut field = constraint.clone();
                                field.as_object_mut().unwrap().remove("const");
                                field["enum"] = Value::Array(choices);
                                shared.insert(name.clone(), field);
                            }
                        }
                    }
                }
                if shared.is_empty() {
                    fields.push(SettingQuestion {
                        path: String::new(),
                        title: Some("Adapter settings".into()),
                        description: Some(
                            "Enter a JSON object matching the adapter's advertised alternatives."
                                .into(),
                        ),
                        required: true,
                        schema: schema.clone(),
                        choices: Vec::new(),
                        suggestion: if schema_accepts(schema, values) == Some(true) {
                            Some(values.clone())
                        } else if required {
                            schema
                                .get("default")
                                .filter(|value| schema_accepts(schema, value) == Some(true))
                                .cloned()
                        } else {
                            None
                        },
                    });
                    return Ok(());
                }
                let required: Vec<_> = shared.keys().cloned().map(Value::String).collect();
                branches.push(serde_json::json!({"properties":shared,"required":required}));
            }
        }
    }
    for branch in branches {
        for key in ["type", "enum", "default", "title", "description", "const"] {
            if effective.get(key).is_none()
                && let Some(value) = branch.get(key)
            {
                effective[key] = value.clone();
            }
        }
        for key in ["properties", "$defs"] {
            if let Some(properties) = branch[key].as_object() {
                let object = effective
                    .as_object_mut()
                    .ok_or_else(|| diagnostic("settings", "Expected an object schema."))?
                    .entry(key)
                    .or_insert_with(|| Value::Object(Map::new()));
                for (name, value) in properties {
                    let fields = object.as_object_mut().unwrap();
                    if let Some(previous) = fields.get(name) {
                        fields.insert(name.clone(), serde_json::json!({"allOf":[previous,value]}));
                    } else {
                        fields.insert(name.clone(), value.clone());
                    }
                }
            }
        }
        if let Some(required) = branch["required"].as_array() {
            effective
                .as_object_mut()
                .unwrap()
                .entry("required")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .unwrap()
                .extend(required.clone());
        }
    }
    if let Some(properties) = effective["properties"]
        .as_object()
        .filter(|_| path.is_empty() || required || !values.is_null())
    {
        for (name, child) in properties {
            let child_path = format!("{path}/{}", name.replace('~', "~0").replace('/', "~1"));
            let child_required = effective["required"]
                .as_array()
                .is_some_and(|names| names.iter().any(|value| value.as_str() == Some(name)));
            collect(
                root,
                child,
                values.get(name).unwrap_or(&Value::Null),
                &child_path,
                child_required,
                fields,
                depth + 1,
            )?;
        }
    } else if !path.is_empty() {
        let mut field_schema = schema.clone();
        for key in ["type", "title", "description"] {
            if field_schema.get(key).is_none()
                && let Some(value) = effective.get(key)
            {
                field_schema[key] = value.clone();
            }
        }
        if let Some(definitions) = root.get("$defs")
            && let Some(object) = field_schema.as_object_mut()
        {
            object.insert("$defs".into(), definitions.clone());
        }
        let suggestion = if !values.is_null() && schema_accepts(&field_schema, values) == Some(true)
        {
            Some(values.clone())
        } else if required {
            effective
                .get("default")
                .filter(|value| schema_accepts(&field_schema, value) == Some(true))
                .cloned()
        } else {
            None
        };
        let choices = effective["enum"]
            .as_array()
            .cloned()
            .or_else(|| effective.get("const").map(|value| vec![value.clone()]))
            .unwrap_or_else(|| {
                if effective["type"] == "boolean" {
                    vec![Value::Bool(false), Value::Bool(true)]
                } else {
                    Vec::new()
                }
            });
        let choices = choices
            .into_iter()
            .filter(|value| schema_accepts(&field_schema, value) == Some(true))
            .collect();
        fields.push(SettingQuestion {
            path: path.into(),
            title: effective["title"].as_str().map(Into::into),
            description: effective["description"].as_str().map(Into::into),
            required,
            schema: field_schema,
            choices,
            suggestion,
        });
    }
    Ok(())
}
