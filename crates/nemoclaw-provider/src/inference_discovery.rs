// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use async_trait::async_trait;
use nemoclaw_sdk::{
    config::InferenceApi,
    inference_discovery::{EndpointRequest, observe_endpoint},
    openshell::EnvironmentSecrets,
};
use serde::{Deserialize, Serialize};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};
pub(crate) struct InferenceDataSource;
#[derive(Serialize, Deserialize)]
pub(crate) struct InferenceState {
    endpoint: Value<String>,
    api: Value<String>,
    credential_env: Value<String>,
    observation_json: Value<String>,
    status: Value<String>,
}
fn api(value: &str) -> Option<InferenceApi> {
    match value {
        "openai-completions" => Some(InferenceApi::OpenaiCompletions),
        "openai-responses" => Some(InferenceApi::OpenaiResponses),
        "anthropic-messages" => Some(InferenceApi::AnthropicMessages),
        _ => None,
    }
}
fn valid(config: &InferenceState) -> bool {
    if matches!(config.endpoint, Value::Null) || matches!(config.api, Value::Null) {
        return false;
    }
    if let Value::Value(endpoint) = &config.endpoint
        && nemoclaw_sdk::config::validate_endpoint(endpoint, false).is_err()
    {
        return false;
    }
    if let Value::Value(value) = &config.api
        && api(value).is_none()
    {
        return false;
    }
    if let Value::Value(reference) = &config.credential_env {
        let endpoint = match &config.endpoint {
            Value::Value(endpoint) => endpoint.as_str(),
            _ => "https://example.invalid",
        };
        if (EndpointRequest {
            endpoint: endpoint.into(),
            api: InferenceApi::OpenaiCompletions,
            credential_env: Some(reference.clone()),
        })
        .validate()
        .is_err()
        {
            return false;
        }
    }
    true
}
#[async_trait]
impl DataSource for InferenceDataSource {
    type State<'a> = InferenceState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("endpoint", AttributeConstraint::Required),
                    ("api", AttributeConstraint::Required),
                    ("credential_env", AttributeConstraint::Optional),
                    ("observation_json", AttributeConstraint::Computed),
                    ("status", AttributeConstraint::Computed),
                ]
                .into_iter()
                .map(|(name, constraint)| {
                    (
                        name.into(),
                        Attribute {
                            attr_type: AttributeType::String,
                            constraint,
                            ..Default::default()
                        },
                    )
                })
                .collect(),
                ..Default::default()
            },
        })
    }
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: InferenceState) -> Option<()> {
        if valid(&config) {
            Some(())
        } else {
            diags.root_error_short(
                "Invalid inference discovery endpoint, API, or credential reference",
            );
            None
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: InferenceState,
        _: ValueEmpty,
    ) -> Option<InferenceState> {
        if !valid(&config) {
            diags.root_error_short("Invalid inference discovery inputs");
            return None;
        }
        let (Value::Value(endpoint), Value::Value(selected_api)) = (&config.endpoint, &config.api)
        else {
            diags.root_error_short("Inference discovery inputs are not yet known");
            return None;
        };
        let credential_env = match &config.credential_env {
            Value::Value(reference) => Some(reference.clone()),
            Value::Null => None,
            Value::Unknown => {
                diags.root_error_short("Inference credential reference is not yet known");
                return None;
            }
        };
        let observed = observe_endpoint(
            &EndpointRequest {
                endpoint: endpoint.clone(),
                api: api(selected_api)?,
                credential_env,
            },
            &EnvironmentSecrets,
        )
        .await;
        config.status = Value::Value(
            match observed.status {
                nemoclaw_sdk::discovery::ObservationStatus::Available => "available",
                nemoclaw_sdk::discovery::ObservationStatus::Unavailable => "unavailable",
                nemoclaw_sdk::discovery::ObservationStatus::Unknown => "unknown",
            }
            .into(),
        );
        config.observation_json = Value::Value(serde_json::to_string(&observed).ok()?);
        Some(config)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn inference_validation_defers_unknowns_without_resolving_credentials() {
        let mut diagnostics = Diagnostics::default();
        let state = InferenceState {
            endpoint: Value::Unknown,
            api: Value::Unknown,
            credential_env: Value::Unknown,
            observation_json: Value::Null,
            status: Value::Null,
        };
        assert!(
            InferenceDataSource
                .validate(&mut diagnostics, state)
                .await
                .is_some()
        );
        let invalid = InferenceState {
            endpoint: Value::Value("https://example.com/v1".into()),
            api: Value::Value("openai-completions".into()),
            credential_env: Value::Value("PRIVATE-SENTINEL".into()),
            observation_json: Value::Null,
            status: Value::Null,
        };
        assert!(
            InferenceDataSource
                .validate(&mut diagnostics, invalid)
                .await
                .is_none()
        );
        assert!(!format!("{diagnostics:?}").contains("PRIVATE-SENTINEL"));
    }
}
