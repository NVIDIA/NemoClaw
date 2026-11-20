// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn native_value<'a>(
    values: &'a Value,
    selected_route: Option<usize>,
    id: &str,
) -> Option<&'a Value> {
    if let Some(path) = id.strip_prefix("workflow:") {
        values.pointer(&format!("{}/workflow{path}", agent_path(values)?))
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
    let sandbox = sandbox_path(values)?;
    let agent = values.pointer(&format!("{sandbox}/agent"))?;
    if agent.get("inference").is_some() {
        return Some(format!("{sandbox}/agent/inference/routes"));
    }
    let reference = agent.get("inferenceRef")?.as_str()?;
    let escaped = reference.replace('~', "~0").replace('/', "~1");
    let path = format!("/spec/inferences/{escaped}/routes");
    values.pointer(&path).is_some().then_some(path)
}

/// The selected sandbox's agent, which owns the Fabric workflow section.
pub(super) fn agent_path(values: &Value) -> Option<String> {
    let path = format!("{}/agent", sandbox_path(values)?);
    values.pointer(&path).is_some().then_some(path)
}

pub(super) fn harness_path(values: &Value) -> Option<String> {
    let path = sandbox_path(values)?;
    let sandbox = values.pointer(&path)?;
    if let Some(reference) = sandbox.get("harnessRef").and_then(Value::as_str) {
        let escaped = reference.replace('~', "~0").replace('/', "~1");
        let path = format!("/spec/harnesses/{escaped}");
        return values.pointer(&path).is_some().then_some(path);
    }
    sandbox
        .get("harness")
        .is_some()
        .then(|| format!("{path}/harness"))
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

/// The key naming the gateway's target, such as `docker` in
/// `target: {docker: {}}`, when the target is an object with one key.
pub(super) fn gateway_target(values: &Value) -> Option<&str> {
    let mut keys = values.pointer(GATEWAY_TARGET)?.as_object()?.keys();
    keys.next()
        .filter(|_| keys.next().is_none())
        .map(String::as_str)
}

/// The selected target and the path of its engine, such as `docker` and
/// `/spec/gateway/target/docker/engine`. A cluster target has no engine.
pub(super) fn gateway_engine(values: &Value) -> Option<(&str, String)> {
    let target = gateway_target(values)?;
    let path = format!("{GATEWAY_TARGET}/{}/engine", escape_pointer(target));
    sdk_field_schema_for(values, &path)
        .is_some()
        .then_some((target, path))
}

/// Whether `path` names a gateway target's engine, whichever target it is.
pub(super) fn is_gateway_engine(path: &str) -> bool {
    path.strip_prefix(GATEWAY_TARGET)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(target, field)| !target.is_empty() && field == "engine")
}

pub(super) fn scalar_question(schema: &Value, choices: &[Value]) -> bool {
    matches!(
        schema["type"].as_str(),
        Some("string" | "number" | "integer" | "boolean")
    ) || !choices.is_empty()
}
