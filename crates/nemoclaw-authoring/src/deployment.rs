// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Questions over existing deployment intent, derived from the SDK input schema.
use crate::{Diagnostics, Draft, SettingQuestion, diagnostics::diagnostic};
use nemoclaw_sdk::{
    config::{Document, schema::input_schema},
    fabric_capabilities::schema_accepts,
};
use serde_json::Value;

impl Draft {
    /// Existing deployment fields that can be edited without changing native adapter settings.
    /// Paths identify their actual locations in the SDK document, including service names.
    pub fn deployment_questions(&self) -> Result<Vec<SettingQuestion>, Diagnostics> {
        if self.document.spec.sandboxes.len() != 1 {
            return Err(diagnostic(
                "deployment",
                "Deployment questions require one sandbox.",
            ));
        }
        let values = serde_json::to_value(&self.document)
            .map_err(|_| diagnostic("deployment", "Cannot read deployment configuration."))?;
        static SCHEMA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
        let schema = SCHEMA.get_or_init(input_schema);
        let mut questions = Vec::new();
        collect(schema, schema, &values, "", &mut questions, 0)?;
        let sandbox = &self.document.spec.sandboxes[0];
        let harness = self
            .document
            .sandbox_harness(sandbox)
            .map_err(|error| diagnostic("deployment", &error.to_string()))?;
        let inference = self
            .document
            .sandbox_inference(sandbox)
            .map_err(|error| diagnostic("deployment", &error.to_string()))?;
        let mut harness_paths = vec!["/spec/sandboxes/0/harness".to_owned()];
        let mut inference_paths = vec!["/spec/sandboxes/0/agent/inference".to_owned()];
        for (base, definitions) in [
            ("/spec/harnesses", &self.document.spec.harnesses),
            ("/spec/sandboxes/0/harnesses", &sandbox.harnesses),
        ] {
            for (name, definition) in definitions {
                if std::ptr::eq(definition, harness) {
                    harness_paths.push(format!("{base}/{}", escaped(name)));
                }
            }
        }
        for (base, definitions) in [
            ("/spec/inferences", &self.document.spec.inferences),
            ("/spec/sandboxes/0/inferences", &sandbox.inferences),
        ] {
            for (name, definition) in definitions {
                if std::ptr::eq(definition, inference) {
                    inference_paths.push(format!("{base}/{}", escaped(name)));
                }
            }
        }
        questions.retain(|question| {
            (!question.path.contains("/execution/")
                || harness_paths
                    .iter()
                    .any(|base| question.path.starts_with(&format!("{base}/execution/"))))
                && (!question.path.contains("/routes/")
                    || inference_paths
                        .iter()
                        .any(|base| question.path.starts_with(&format!("{base}/routes/"))))
        });
        Ok(questions)
    }

    /// Validate the entire proposed document before accepting an active question's answer.
    pub fn answer_deployment_question(
        &mut self,
        path: &str,
        value: Value,
    ) -> Result<(), Diagnostics> {
        let question = self
            .deployment_questions()?
            .into_iter()
            .find(|question| question.path == path)
            .ok_or_else(|| {
                diagnostic(
                    "deployment",
                    "This deployment question is no longer active.",
                )
            })?;
        if schema_accepts(&question.schema, &value) != Some(true) {
            return Err(diagnostic(
                "deployment",
                "The answer does not satisfy the SDK field schema.",
            ));
        }
        let mut values = serde_json::to_value(&self.document)
            .map_err(|_| diagnostic("deployment", "Cannot read deployment configuration."))?;
        *values
            .pointer_mut(path)
            .ok_or_else(|| diagnostic("deployment", "The field no longer exists."))? = value;
        let document = Document::parse(values.to_string().as_bytes())
            .map_err(|error| diagnostic("deployment", &error.to_string()))?;
        if document == self.document {
            return Ok(());
        }
        self.replace_document(document)
    }
}

fn escaped(part: &str) -> String {
    part.replace('~', "~0").replace('/', "~1")
}

// These are deployment-owned editing regions, not a second description of their fields
// or constraints. Native settings and model/provider choices have separate owner views.
fn region(path: &str) -> bool {
    path.starts_with("/spec/gateway/")
        || path.starts_with("/spec/services/")
        || path.starts_with("/spec/sandboxes/0/image/")
        || path.starts_with("/spec/sandboxes/0/network/")
        || path.starts_with("/spec/sandboxes/0/agent/auth/")
        || path.starts_with("/spec/sandboxes/0/harness/execution/")
        || (path.contains("/routes/") && path.ends_with("/overrides/maxTokens"))
        || (path.contains("/harnesses/") && path.contains("/execution/"))
}
fn excluded(path: &str) -> bool {
    path.ends_with("/management")
        || (path.starts_with("/spec/services/") && path.ends_with("/kind"))
}
fn complex(path: &str) -> bool {
    (path.starts_with("/spec/services/") && path.ends_with("/recipe"))
        || path == "/spec/sandboxes/0/network/policy"
}
fn full_schema(root: &Value, mut schema: Value) -> Value {
    fn has_reference(value: &Value) -> bool {
        match value {
            Value::Object(fields) => {
                fields.contains_key("$ref") || fields.values().any(has_reference)
            }
            Value::Array(values) => values.iter().any(has_reference),
            _ => false,
        }
    }
    if has_reference(&schema)
        && let Some(object) = schema.as_object_mut()
    {
        object.insert("$defs".into(), root["$defs"].clone());
    }
    schema
}
fn effective(
    root: &Value,
    schema: &Value,
    value: &Value,
    depth: usize,
) -> Result<Value, Diagnostics> {
    if depth > 32 {
        return Err(diagnostic(
            "deployment",
            "SDK schema reference depth exceeded.",
        ));
    }
    let mut resolved = if let Some(reference) = schema["$ref"].as_str() {
        let target = reference
            .strip_prefix('#')
            .and_then(|pointer| root.pointer(pointer))
            .ok_or_else(|| diagnostic("deployment", "Cannot resolve SDK schema reference."))?;
        effective(root, target, value, depth + 1)?
    } else {
        schema.clone()
    };
    for keyword in ["oneOf", "anyOf", "allOf"] {
        if let Some(branches) = resolved[keyword].as_array().cloned() {
            for branch in branches {
                // Scalar alternatives do not add child fields. Preserve their schema
                // for answer validation without compiling a validator during traversal.
                if !value.is_object() {
                    continue;
                }
                let branch = effective(root, &branch, value, depth + 1)?;
                if branch.get("properties").is_none() {
                    continue;
                }
                if keyword != "allOf" {
                    let discriminators: Vec<_> = branch["properties"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .filter_map(|(key, constraint)| {
                            constraint.get("const").map(|constant| (key, constant))
                        })
                        .collect();
                    let active = if discriminators.is_empty() {
                        schema_accepts(&full_schema(root, branch.clone()), value) == Some(true)
                    } else {
                        discriminators
                            .iter()
                            .all(|(key, constant)| value.get(*key) == Some(*constant))
                    };
                    if !active {
                        continue;
                    }
                }
                if let Some(properties) = branch["properties"].as_object() {
                    if !resolved["properties"].is_object() {
                        resolved["properties"] = serde_json::json!({});
                    }
                    resolved["properties"]
                        .as_object_mut()
                        .unwrap()
                        .extend(properties.clone());
                }
                if resolved.get("type").is_none()
                    && let Some(kind) = branch.get("type")
                {
                    resolved["type"] = kind.clone();
                }
            }
        }
    }
    Ok(resolved)
}
fn collect(
    root: &Value,
    schema: &Value,
    value: &Value,
    path: &str,
    out: &mut Vec<SettingQuestion>,
    depth: usize,
) -> Result<(), Diagnostics> {
    if depth > 48 {
        return Err(diagnostic(
            "deployment",
            "Deployment question depth exceeded.",
        ));
    }
    if value.is_null() || !interested(path) {
        return Ok(());
    }
    let resolved = effective(root, schema, value, 0)?;
    if region(path)
        && !excluded(path)
        && (!value.is_object() && !value.is_array() || complex(path) || value.is_array())
    {
        let mut choices = resolved["enum"].as_array().cloned().unwrap_or_default();
        if choices.is_empty() && resolved["type"] == "boolean" {
            choices = vec![Value::Bool(false), Value::Bool(true)];
        }
        for keyword in ["oneOf", "anyOf"] {
            if let Some(branches) = resolved[keyword].as_array()
                && branches.iter().all(|branch| branch.get("const").is_some())
            {
                for branch in branches {
                    let choice = &branch["const"];
                    if !choices.contains(choice) {
                        choices.push(choice.clone());
                    }
                }
            }
        }
        out.push(SettingQuestion {
            path: path.into(),
            title: title(path),
            description: schema["description"]
                .as_str()
                .or_else(|| resolved["description"].as_str())
                .unwrap_or(
                    "Edit this deployment value; the SDK validates the complete configuration.",
                )
                .into(),
            required: true,
            schema: full_schema(root, resolved),
            choices,
            suggestion: Some(value.clone()),
        });
        return Ok(());
    }
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            let child_schema = resolved["properties"].get(key).or_else(|| {
                resolved
                    .get("additionalProperties")
                    .filter(|schema| schema.is_object())
            });
            if let Some(child_schema) = child_schema {
                collect(
                    root,
                    child_schema,
                    child,
                    &format!("{path}/{}", escaped(key)),
                    out,
                    depth + 1,
                )?;
            }
        }
    } else if let Some(array) = value.as_array()
        && let Some(items) = resolved.get("items")
    {
        for (index, child) in array.iter().enumerate() {
            collect(
                root,
                items,
                child,
                &format!("{path}/{index}"),
                out,
                depth + 1,
            )?;
        }
    }
    Ok(())
}

fn title(path: &str) -> String {
    fn words(value: &str) -> String {
        let mut result = String::new();
        let mut previous_lower = false;
        for ch in value.chars() {
            if ch.is_uppercase() && previous_lower {
                result.push(' ');
            }
            result.push(ch);
            previous_lower = ch.is_lowercase();
        }
        result
    }
    let parts: Vec<_> = path.split('/').filter(|part| !part.is_empty()).collect();
    let (prefix, rest) = if parts.get(1) == Some(&"gateway") {
        ("Gateway".to_owned(), &parts[2..])
    } else if parts.get(1) == Some(&"services") {
        (
            format!("Service {}", parts.get(2).unwrap_or(&"")),
            &parts[3..],
        )
    } else if parts.get(1) == Some(&"sandboxes") {
        ("Agent".to_owned(), &parts[3..])
    } else {
        ("Deployment".to_owned(), &parts[1..])
    };
    format!(
        "{prefix}: {}",
        rest.iter()
            .filter(|part| !matches!(**part, "agent" | "harness") && part.parse::<usize>().is_err())
            .map(|part| words(part))
            .collect::<Vec<_>>()
            .join(" / ")
    )
}

fn interested(path: &str) -> bool {
    [
        "/spec/gateway",
        "/spec/services",
        "/spec/sandboxes/0/image",
        "/spec/sandboxes/0/network",
        "/spec/sandboxes/0/agent/auth",
        "/spec/sandboxes/0/harness/execution",
        "/spec/sandboxes/0/agent/inference",
        "/spec/inferences",
        "/spec/sandboxes/0/inferences",
        "/spec/harnesses",
        "/spec/sandboxes/0/harnesses",
    ]
    .iter()
    .any(|root| {
        path == *root
            || path.starts_with(&format!("{root}/"))
            || root.starts_with(&format!("{path}/"))
    }) && !path.contains("/settings")
        && !path.contains("/config")
}
