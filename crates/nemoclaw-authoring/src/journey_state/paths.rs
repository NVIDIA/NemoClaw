// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn native_value<'a>(
    values: &'a Value,
    selected_route: Option<usize>,
    id: &str,
) -> Option<&'a Value> {
    if let Some(path) = id.strip_prefix("workflow:") {
        values.pointer(&format!("{}/config/workflow{path}", harness_path(values)?))
    } else if let Some(path) = id.strip_prefix("model:") {
        values.pointer(&format!(
            "{}/{}/overrides/settings{path}",
            routes_path(values)?,
            selected_route?
        ))
    } else {
        None
    }
}

pub(super) fn routes_path(values: &Value) -> Option<String> {
    let agent = values.pointer("/spec/sandboxes/0/agent")?;
    if agent.get("inference").is_some() {
        return Some(ROUTES.into());
    }
    let reference = agent.get("inferenceRef")?.as_str()?;
    let escaped = reference.replace('~', "~0").replace('/', "~1");
    let path = format!("/spec/inferences/{escaped}/routes");
    values.pointer(&path).is_some().then_some(path)
}

pub(super) fn harness_path(values: &Value) -> Option<String> {
    let sandbox = values.pointer("/spec/sandboxes/0")?;
    if let Some(reference) = sandbox.get("harnessRef").and_then(Value::as_str) {
        let escaped = reference.replace('~', "~0").replace('/', "~1");
        let path = format!("/spec/harnesses/{escaped}");
        return values.pointer(&path).is_some().then_some(path);
    }
    sandbox
        .get("harness")
        .is_some()
        .then(|| "/spec/sandboxes/0/harness".into())
}

pub(super) fn harness_kind(values: &Value) -> Option<&str> {
    values
        .pointer(&format!("{}/kind", harness_path(values)?))
        .and_then(Value::as_str)
}

pub(super) fn settings_path(values: &Value) -> Option<String> {
    harness_path(values).map(|path| format!("{path}/settings"))
}

pub(super) fn escape_pointer(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

pub(super) fn scalar_question(schema: &Value, choices: &[Value]) -> bool {
    matches!(
        schema["type"].as_str(),
        Some("string" | "number" | "integer" | "boolean")
    ) || !choices.is_empty()
}
