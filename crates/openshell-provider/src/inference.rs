// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
pub(super) const PROVIDERS_ENV: &str = "NEMOCLAW_PROVIDER_NAMES";

pub(super) fn provider_names(text: &str) -> Result<Vec<String>, ObservationError> {
    let names: Vec<String> = serde_json::from_str(text).map_err(|_| ObservationError::Query)?;
    let unique: std::collections::BTreeSet<_> = names.iter().collect();
    if names.is_empty()
        || names.len() > 128
        || unique.len() != names.len()
        || names
            .iter()
            .any(|name| !nemoclaw_openshell::valid_name(name))
    {
        return Err(ObservationError::Query);
    }
    Ok(names)
}

pub(super) fn inference_environment(row: &Row) -> Result<Row, ObservationError> {
    let text = row
        .get("provider_names_json")
        .map(String::as_str)
        .unwrap_or("");
    provider_names(text)?;
    let mut env = agent::launch(row)?.environment;
    env.insert(PROVIDERS_ENV.into(), text.into());
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_attachments_are_deployment_references_not_fabric_transports() {
        assert_eq!(
            provider_names(r#"["owned-registration"]"#).unwrap(),
            ["owned-registration"]
        );
        for invalid in [
            "[]",
            r#"["duplicate","duplicate"]"#,
            r#"["bad name"]"#,
            r#"{"provider":"openai"}"#,
        ] {
            assert!(provider_names(invalid).is_err());
        }
    }
}
