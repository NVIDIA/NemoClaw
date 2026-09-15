// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::config::RuntimeInference;

pub(super) const INFERENCE_ENV: &str = "NEMOCLAW_INFERENCE_CONFIG";
pub(super) fn inference_settings(
    text: &str,
    runtime: &str,
) -> Result<Option<RuntimeInference>, ObservationError> {
    if text.is_empty() {
        return Ok(None);
    }
    let settings: RuntimeInference =
        serde_json::from_str(text).map_err(|_| ObservationError::Query)?;
    settings
        .validate(
            runtime
                .strip_prefix("fabric-")
                .ok_or(ObservationError::Query)?,
        )
        .map_err(|_| ObservationError::Query)?;
    if serde_json::to_string(&settings).map_err(|_| ObservationError::Query)? != text {
        return Err(ObservationError::Query);
    }
    Ok(Some(settings))
}
pub(super) fn inference_environment(row: &Row) -> Result<Row, ObservationError> {
    let runtime = row.get("agent_runtime").map(String::as_str).unwrap_or("");
    let text = row.get("inference_json").map(String::as_str).unwrap_or("");
    let mut env = launch_environment(
        row.get("agent_name").map(String::as_str).unwrap_or(""),
        runtime,
        row_proxy(row)?.as_ref(),
    );
    if inference_settings(text, runtime)?.is_some() {
        env.insert(INFERENCE_ENV.into(), text.into());
    }
    Ok(env)
}
