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
                .ok_or(ObservationError::Query)?
                .parse()
                .map_err(|_| ObservationError::Query)?,
        )
        .map_err(|_| ObservationError::Query)?;
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
    if let Some(search) = &settings.web_search {
        providers.push(crate::config::search_provider_name(&search.credential.env));
    }
    Ok(providers)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inference_json_accepts_hcl_encoding_and_rejects_invalid_settings() {
        let valid = serde_json::json!({
            "provider": "local",
            "connection": {"provider":"openai", "model":"fixture-model",
                "base_url":"http://127.0.0.1:11434/v1", "api_key_env":"NEMOCLAW_ANONYMOUS_API_KEY"},
            "api":"openai-completions", "tuning":{}
        });
        for encoded in [
            valid.to_string(),
            serde_json::to_string_pretty(&valid).unwrap(),
        ] {
            assert!(inference_settings(&encoded, "fabric-openclaw").is_ok());
        }
        let mut unknown = valid.clone();
        unknown["unexpected"] = true.into();
        let mut invalid = valid;
        invalid["connection"]["api_key_env"] = "INVALID".into();
        for encoded in [unknown.to_string(), invalid.to_string(), "{".into()] {
            assert!(inference_settings(&encoded, "fabric-openclaw").is_err());
        }
    }
}
