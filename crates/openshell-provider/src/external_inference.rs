// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `openshell_external_inference_server`: an inference server NemoClaw doesn't
//! run, such as a hosted API or an IT-run LiteLLM proxy. Reading it checks the
//! server's model list and exports the `inference_server` ref that inference
//! registrations take. Which destinations sandboxes may reach is OpenShell's
//! to decide, so only the URL's shape is checked here.
use async_trait::async_trait;
use nemoclaw_sdk::{
    EnvironmentSecrets,
    config::InferenceApi,
    discovery::ObservationStatus,
    inference_discovery::{AuthenticationStatus, EndpointRequest, observe_server},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// The type of the ref this data source and runtime readiness reads export.
const SERVER_TYPE: &str = "inference_server";
/// The attributes of an `inference_server` ref.
const SERVER_FIELDS: [&str; 5] = [
    "type",
    "endpoint",
    "model",
    "credential_env",
    "credential_source",
];

pub(crate) struct ExternalInferenceServer;

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct ExternalInferenceState {
    /// The URL the machine running OpenTofu checks.
    endpoint: Value<String>,
    /// The URL gateways and sandboxes use; defaults to `endpoint`.
    sandbox_endpoint: Value<String>,
    api: Value<String>,
    /// A model the server must list.
    model: Value<String>,
    /// The variable holding a key for listing models; never its value.
    credential_env: Value<String>,
    read_trigger: Value<bool>,
    #[serde(rename = "ref")]
    reference: Value<BTreeMap<String, Value<String>>>,
}

fn text(value: &Value<String>) -> Option<&str> {
    match value {
        Value::Value(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

/// The check's request, or `None` while an input is unknown.
fn request(
    config: &ExternalInferenceState,
) -> Result<Option<EndpointRequest>, (String, &'static str)> {
    let (Value::Value(endpoint), Value::Value(api)) = (&config.endpoint, &config.api) else {
        return Ok(None);
    };
    if [
        &config.sandbox_endpoint,
        &config.model,
        &config.credential_env,
    ]
    .iter()
    .any(|value| matches!(value, Value::Unknown))
    {
        return Ok(None);
    }
    let api: InferenceApi = serde_json::from_value(serde_json::json!(api)).map_err(|_| {
        (
            "api must be openai-completions, openai-responses, or anthropic-messages".to_owned(),
            "api",
        )
    })?;
    let request = EndpointRequest {
        endpoint: endpoint.clone(),
        api,
        credential_env: text(&config.credential_env).map(str::to_owned),
    };
    request
        .validate_shape()
        .map_err(|error| (error.to_string(), "endpoint"))?;
    if let Some(sandbox) = text(&config.sandbox_endpoint) {
        EndpointRequest {
            endpoint: sandbox.to_owned(),
            api,
            credential_env: None,
        }
        .validate_shape()
        .map_err(|error| (error.to_string(), "sandbox_endpoint"))?;
    }
    Ok(Some(request))
}

#[async_trait]
impl DataSource for ExternalInferenceServer {
    type State<'a> = ExternalInferenceState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, Object, String};
        let server = Object(
            SERVER_FIELDS
                .iter()
                .map(|name| ((*name).to_owned(), String))
                .collect::<HashMap<_, _>>(),
        );
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("endpoint", String, Required),
                    ("sandbox_endpoint", String, Optional),
                    ("api", String, Required),
                    ("model", String, Optional),
                    ("credential_env", String, Optional),
                    ("read_trigger", Bool, Optional),
                    ("ref", server, Computed),
                ]
                .into_iter()
                .map(|(name, attr_type, constraint)| {
                    (
                        name.into(),
                        Attribute {
                            attr_type,
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

    async fn validate<'a>(
        &self,
        diags: &mut Diagnostics,
        config: ExternalInferenceState,
    ) -> Option<()> {
        match request(&config) {
            Ok(_) => Some(()),
            Err((detail, attribute)) => {
                diags.error(
                    "Invalid inference server",
                    detail,
                    AttributePath::new(attribute),
                );
                None
            }
        }
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: ExternalInferenceState,
        _: ValueEmpty,
    ) -> Option<ExternalInferenceState> {
        let request = match request(&config) {
            Ok(Some(request)) => request,
            Ok(None) => {
                diags.root_error_short("Inference server inputs are not yet known");
                return None;
            }
            Err((detail, attribute)) => {
                diags.error(
                    "Invalid inference server",
                    detail,
                    AttributePath::new(attribute),
                );
                return None;
            }
        };
        let observed = observe_server(&request, &EnvironmentSecrets).await;
        let model = text(&config.model).unwrap_or_default().to_owned();
        let credential = text(&config.credential_env).unwrap_or_default().to_owned();
        // Fixed messages only: never the key, nor the server's own error text.
        let failure = match observed.authentication {
            AuthenticationStatus::Required if credential.is_empty() => Some(
                "the server requires a key: set credential_env to a variable that holds one"
                    .to_owned(),
            ),
            AuthenticationStatus::Required => Some(format!(
                "the server requires a key: set {credential} on the machine running OpenTofu"
            )),
            AuthenticationStatus::Denied => {
                Some(format!("the server refused the key in {credential}"))
            }
            _ if observed.status != ObservationStatus::Available => Some(format!(
                "the server did not return a model list: {}",
                observed.reason.as_deref().unwrap_or("no reason reported")
            )),
            _ if !model.is_empty() && !observed.models.contains(&model) => {
                Some(format!("the server does not list model {model}"))
            }
            _ => None,
        };
        if let Some(failure) = failure {
            diags.root_error("Inference server is not ready", failure);
            return None;
        }
        let endpoint = text(&config.sandbox_endpoint)
            .unwrap_or(&request.endpoint)
            .to_owned();
        config.reference = Value::Value(BTreeMap::from([
            ("type".to_owned(), Value::Value(SERVER_TYPE.to_owned())),
            ("endpoint".to_owned(), Value::Value(endpoint)),
            ("model".to_owned(), Value::Value(model)),
            ("credential_env".to_owned(), Value::Value(credential)),
            ("credential_source".to_owned(), Value::Value(String::new())),
        ]));
        Some(config)
    }
}
