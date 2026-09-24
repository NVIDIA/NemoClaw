// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
pub(super) const PROVIDERS_ENV: &str = "NEMOCLAW_PROVIDER_NAMES";

pub(super) fn provider_names(text: &str, runtime: &str) -> Result<Vec<String>, ObservationError> {
    if runtime != "fabric" {
        return Err(ObservationError::Query);
    }
    let names: Vec<String> = serde_json::from_str(text).map_err(|_| ObservationError::Query)?;
    let unique: std::collections::BTreeSet<_> = names.iter().collect();
    if names.is_empty()
        || names.len() > 128
        || unique.len() != names.len()
        || names
            .iter()
            .any(|name| !crate::config::validation::valid_name(name))
    {
        return Err(ObservationError::Query);
    }
    Ok(names)
}

pub(super) fn inference_environment(row: &Row) -> Result<Row, ObservationError> {
    let runtime = row.get("agent_runtime").map(String::as_str).unwrap_or("");
    let text = row
        .get("provider_names_json")
        .map(String::as_str)
        .unwrap_or("");
    provider_names(text, runtime)?;
    let mut env = launch_environment(
        row.get("agent_name").map(String::as_str).unwrap_or(""),
        runtime,
        row_proxy(row)?.as_ref(),
    );
    env.insert(PROVIDERS_ENV.into(), text.into());
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_attachments_are_deployment_references_not_fabric_transports() {
        assert_eq!(
            provider_names(r#"["owned-registration"]"#, "fabric").unwrap(),
            ["owned-registration"]
        );
        for invalid in [
            "[]",
            r#"["duplicate","duplicate"]"#,
            r#"["bad name"]"#,
            r#"{"provider":"openai"}"#,
        ] {
            assert!(provider_names(invalid, "fabric").is_err());
        }
        assert!(provider_names(r#"["valid"]"#, "fabric-pi").is_err());
    }
}
