// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Deployment question discovery from the SDK input schema.

use crate::{
    Diagnostics,
    diagnostics::diagnostic,
    sdk_schema::{finite_choices, sdk_field_schema_for},
    settings::SettingQuestion,
};
use serde_json::Value;

pub(crate) fn deployment_questions_for_values(
    values: &Value,
    active_harness: Option<&str>,
    active_routes: Option<&str>,
) -> Result<Vec<SettingQuestion>, Diagnostics> {
    let mut questions = Vec::new();
    collect(values, values, "", &mut questions, 0)?;
    questions.retain(|question| {
        (!question.path.contains("/execution/")
            || active_harness
                .is_some_and(|base| question.path.starts_with(&format!("{base}/execution/"))))
            && (!question.path.contains("/routes/")
                || active_routes.is_some_and(|base| question.path.starts_with(&format!("{base}/"))))
    });
    Ok(questions)
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
fn collect(
    root: &Value,
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
    if region(path)
        && !excluded(path)
        && (!value.is_object() && !value.is_array() || complex(path) || value.is_array())
    {
        let Some((schema, required)) = sdk_field_schema_for(root, path) else {
            // A `false` schema accepts no value, so the only answer is to omit
            // (remove) the supplied field.
            out.push(SettingQuestion {
                path: path.into(),
                title: Some(title(path)),
                description: Some(
                    "The SDK schema does not define this field. Omit it to remove the value."
                        .into(),
                ),
                required: false,
                schema: Value::Bool(false),
                choices: Vec::new(),
                suggestion: Some(value.clone()),
            });
            return Ok(());
        };
        let mut choices = finite_choices(&schema);
        if choices.is_empty() && schema["type"] == "boolean" {
            choices = vec![Value::Bool(false), Value::Bool(true)];
        }
        out.push(SettingQuestion {
            path: path.into(),
            title: Some(title(path)),
            description: schema["description"].as_str().map(Into::into),
            required,
            schema,
            choices,
            suggestion: Some(value.clone()),
        });
        return Ok(());
    }
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            collect(
                root,
                child,
                &format!("{path}/{}", escaped(key)),
                out,
                depth + 1,
            )?;
        }
    } else if let Some(array) = value.as_array() {
        for (index, child) in array.iter().enumerate() {
            collect(root, child, &format!("{path}/{index}"), out, depth + 1)?;
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
