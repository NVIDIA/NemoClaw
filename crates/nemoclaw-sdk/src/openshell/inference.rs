// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::config::SandboxRuntimeSettings;

pub(super) const INFERENCE_ENV: &str = "NEMOCLAW_INFERENCE_CONFIG";
pub(super) fn inference_settings(
    text: &str,
    runtime: &str,
) -> Result<Option<SandboxRuntimeSettings>, ObservationError> {
    if text.is_empty() {
        return Ok(None);
    }
    let settings: SandboxRuntimeSettings =
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
    if let Some(settings) = inference_settings(text, runtime)? {
        if settings
            .agents
            .first()
            .is_some_and(|agent| Some(&agent.name) != row.get("agent_name"))
        {
            return Err(ObservationError::BindingMismatch);
        }
        env.insert(INFERENCE_ENV.into(), text.into());
    }
    Ok(env)
}

pub(super) fn provider_names(text: &str, runtime: &str) -> Result<Vec<String>, ObservationError> {
    let settings = inference_settings(text, runtime)?.ok_or(ObservationError::Incomplete)?;
    let mut selected = std::collections::BTreeSet::new();
    for agent in &settings.agents {
        if let Some(inference) = &agent.inference {
            selected.extend(
                inference
                    .models
                    .values()
                    .map(|model| model.provider.clone()),
            );
        }
    }
    selected.remove(&settings.provider);
    let mut providers = vec![settings.provider];
    providers.extend(selected);
    if settings.web_search.is_some() {
        providers.push("brave-search".into());
    }
    Ok(providers)
}
