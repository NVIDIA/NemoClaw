// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::provider::ConfiguredBackend;
use crate::services;
use async_trait::async_trait;
use nemoclaw_sdk::{CancellationToken, Error};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// Data source for one runtime's service readiness.
pub(crate) struct ReadinessDataSource(pub Arc<ConfiguredBackend>, pub services::ServiceRuntime);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct ReadinessState {
    engine: Value<String>,
    name: Value<String>,
    contract: Value<String>,
    container_id: Value<String>,
    /// The server's OpenAI-compatible base URL, ending in `/v1`, that the
    /// provider checks; set instead of the container inputs.
    endpoint: Value<String>,
    /// The base URL gateways and sandboxes use; defaults to `endpoint`.
    sandbox_endpoint: Value<String>,
    wait_timeout_seconds: Value<u64>,
    read_trigger: Value<bool>,
    ready: Value<bool>,
    #[serde(rename = "ref")]
    reference: Value<BTreeMap<String, Value<String>>>,
}

/// The type of the `ref` endpoint readiness exports, for any runtime.
const SERVER_TYPE: &str = "inference_server";

fn endpoint_mode(config: &ReadinessState) -> bool {
    !matches!(config.endpoint, Value::Null)
}

/// An OpenAI-compatible base URL: http or https, a host, a path ending in
/// `/v1`, and no credentials, query, or fragment.
fn base_url(url: &str, name: &'static str) -> Result<(), Error> {
    let invalid = || {
        Error::Configuration(nemoclaw_sdk::config::ConfigError(format!(
            "{name} must be an http or https URL with a host and a path ending in /v1, without credentials, query, or fragment"
        )))
    };
    let parsed = url::Url::parse(url).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.path().trim_end_matches('/').ends_with("/v1")
    {
        return Err(invalid());
    }
    Ok(())
}

/// The model an unauthenticated runtime contract serves.
/// The model a contract serves, and whether its server requires the key the
/// runtime generates: vLLM when the contract enables authentication, and
/// every Ollama proxy.
fn served(contract: &str, proxy: bool) -> Result<(String, bool), Error> {
    if proxy {
        let settings: serde_json::Value = serde_json::from_str(contract)
            .map_err(|_| Error::State("proxy contract is invalid"))?;
        let model = settings["model"]
            .as_str()
            .ok_or(Error::State("proxy contract names no model"))?;
        return Ok((model.to_owned(), true));
    }
    Ok(match nemoclaw_runtime::RuntimeSpec::decode(contract)? {
        nemoclaw_runtime::RuntimeSpec::Vllm(service) => (
            service.served_model().to_owned(),
            service.authentication.is_some(),
        ),
        nemoclaw_runtime::RuntimeSpec::Ollama(service) => (service.model.name.clone(), false),
    })
}

/// The model an unauthenticated runtime contract serves.
fn served_model(contract: &str) -> Result<String, Error> {
    let (model, authenticated) = served(contract, false)?;
    if authenticated {
        return Err(Error::Conflict(
            "endpoint readiness serves unauthenticated servers only; read an authenticated server's readiness through its container inputs",
        ));
    }
    Ok(model)
}

/// The `inference_server` ref for a ready server.
fn server_ref(
    endpoint: String,
    model: String,
    credential_source: String,
) -> BTreeMap<String, Value<String>> {
    BTreeMap::from([
        ("type".to_owned(), Value::Value(SERVER_TYPE.to_owned())),
        ("endpoint".to_owned(), Value::Value(endpoint)),
        ("model".to_owned(), Value::Value(model)),
        ("credential_env".to_owned(), Value::Value(String::new())),
        (
            "credential_source".to_owned(),
            Value::Value(credential_source),
        ),
    ])
}

fn validate_endpoint_mode(
    config: &ReadinessState,
    runtime: services::ServiceRuntime,
) -> Result<(), Error> {
    if [&config.engine, &config.name, &config.container_id]
        .iter()
        .any(|value| !matches!(value, Value::Null))
    {
        return Err(Error::Conflict(
            "readiness takes either endpoint or the container inputs engine, name, and container_id, not both",
        ));
    }
    if runtime == services::ServiceRuntime::OllamaProxy {
        return Err(Error::Conflict(
            "Ollama proxy readiness reads its container; set engine, name, and container_id",
        ));
    }
    for (value, name) in [
        (&config.endpoint, "endpoint"),
        (&config.sandbox_endpoint, "sandbox_endpoint"),
    ] {
        if let Value::Value(url) = value {
            base_url(url, name)?;
        }
    }
    match &config.contract {
        Value::Value(contract) => {
            runtime.check(contract)?;
            served_model(contract).map(|_| ())
        }
        Value::Unknown => Ok(()),
        Value::Null => Err(Error::State("service readiness contract is required")),
    }
}

/// The model IDs an OpenAI-compatible server lists, or `None` when it does not
/// answer with a model list.
async fn listed_models(client: &reqwest::Client, endpoint: &str) -> Option<Vec<String>> {
    let url = format!("{}/models", endpoint.trim_end_matches('/'));
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.len() > 1 << 20 {
        return None;
    }
    let body: serde_json::Value = serde_json::from_slice(&body).ok()?;
    Some(
        body["data"]
            .as_array()?
            .iter()
            .filter_map(|model| model["id"].as_str().map(str::to_owned))
            .collect(),
    )
}

/// Wait until `endpoint` lists `model`, polling until `timeout`.
async fn wait_endpoint_ready(endpoint: &str, model: &str, timeout: Duration) -> Result<(), Error> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Error::State("cannot build the readiness HTTP client"))?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if listed_models(&client, endpoint)
            .await
            .is_some_and(|models| models.iter().any(|listed| listed == model))
        {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(Error::Configuration(nemoclaw_sdk::config::ConfigError(
                format!(
                    "the server does not list model {model} at its endpoint; check that it is running and serving that model"
                ),
            )));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
/// The readiness inputs, or `None` while any is unknown.
fn readiness(
    config: &ReadinessState,
    runtime: services::ServiceRuntime,
) -> Result<Option<services::Readiness>, Error> {
    let mut known = Vec::new();
    for (value, required) in [
        (&config.engine, "service readiness engine is required"),
        (&config.name, "service readiness container name is required"),
        (&config.contract, "service readiness contract is required"),
    ] {
        match value {
            Value::Value(value) => known.push(value.as_str()),
            Value::Unknown => {}
            Value::Null => return Err(Error::State(required)),
        }
    }
    match known[..] {
        [engine, name, contract] => {
            runtime.check(contract)?;
            services::Readiness::new(engine, name, contract).map(Some)
        }
        _ => Ok(None),
    }
}
fn validate(config: &ReadinessState, runtime: services::ServiceRuntime) -> Result<(), Error> {
    if matches!(config.wait_timeout_seconds, Value::Value(seconds) if seconds > 9 * 3600) {
        return Err(Error::State(
            "service readiness wait must be between 0 and 32400 seconds",
        ));
    }
    if endpoint_mode(config) {
        return validate_endpoint_mode(config, runtime);
    }
    if let Value::Value(url) = &config.sandbox_endpoint {
        base_url(url, "sandbox_endpoint")?;
    }
    readiness(config, runtime)?;
    if matches!(&config.container_id, Value::Null)
        || matches!(&config.container_id, Value::Value(id) if id.is_empty())
    {
        return Err(Error::State(
            "service readiness container identity is required",
        ));
    }
    if matches!(config.wait_timeout_seconds, Value::Value(seconds) if seconds > 9 * 3600) {
        return Err(Error::State(
            "service readiness wait must be between 0 and 32400 seconds",
        ));
    }
    Ok(())
}
#[async_trait]
impl DataSource for ReadinessDataSource {
    type State<'a> = ReadinessState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, Number, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("engine", String, Optional),
                    ("name", String, Optional),
                    ("contract", String, Required),
                    ("container_id", String, Optional),
                    ("endpoint", String, Optional),
                    ("sandbox_endpoint", String, Optional),
                    ("wait_timeout_seconds", Number, Optional),
                    ("read_trigger", Bool, Optional),
                    ("ready", Bool, Computed),
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
                .chain([(
                    "ref".into(),
                    Attribute {
                        attr_type: AttributeType::Object(std::collections::HashMap::from([
                            ("type".into(), String),
                            ("endpoint".into(), String),
                            ("model".into(), String),
                            ("credential_env".into(), String),
                            ("credential_source".into(), String),
                        ])),
                        constraint: Computed,
                        ..Default::default()
                    },
                )])
                .collect(),
                ..Default::default()
            },
        })
    }
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: ReadinessState) -> Option<()> {
        match validate(&config, self.1) {
            Ok(()) => Some(()),
            Err(error) => {
                diags.root_error("Invalid service readiness requirements", error.to_string());
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: ReadinessState,
        _: ValueEmpty,
    ) -> Option<ReadinessState> {
        if endpoint_mode(&config) {
            let work = async {
                validate(&config, self.1)?;
                let (Value::Value(endpoint), Value::Value(contract)) =
                    (&config.endpoint, &config.contract)
                else {
                    return Err(Error::State("service readiness endpoint is not yet known"));
                };
                let model = served_model(contract)?;
                let timeout = match config.wait_timeout_seconds {
                    Value::Value(seconds) => seconds,
                    _ => 9 * 3600,
                };
                wait_endpoint_ready(endpoint, &model, Duration::from_secs(timeout)).await?;
                let sandbox = match &config.sandbox_endpoint {
                    Value::Value(sandbox) => sandbox.clone(),
                    _ => endpoint.clone(),
                };
                Ok(server_ref(sandbox, model, String::new()))
            }
            .await;
            return match work {
                Ok(reference) => {
                    config.ready = Value::Value(true);
                    config.reference = Value::Value(reference);
                    Some(config)
                }
                Err(error) => {
                    diags.root_error("Service readiness observation failed", error.to_string());
                    None
                }
            };
        }
        let work = async {
            validate(&config, self.1)?;
            let (Some(readiness), Value::Value(id)) =
                (readiness(&config, self.1)?, &config.container_id)
            else {
                return Err(Error::State("service readiness identity is not yet known"));
            };
            if matches!(config.read_trigger, Value::Unknown) {
                return Err(Error::State(
                    "service readiness read trigger is not yet known",
                ));
            }
            let timeout = match config.wait_timeout_seconds {
                Value::Null => 9 * 3600,
                Value::Value(seconds) => seconds,
                Value::Unknown => {
                    return Err(Error::State("service readiness wait is not yet known"));
                }
            };
            services::wait_service_ready(
                self.0.connections(),
                &readiness,
                id,
                Duration::from_secs(timeout),
                &CancellationToken::new(),
            )
            .await?;
            // Given the address sandboxes use, export the server's ref; an
            // authenticated server's names where its generated key lives.
            let (Value::Value(sandbox), Value::Value(engine), Value::Value(contract)) =
                (&config.sandbox_endpoint, &config.engine, &config.contract)
            else {
                return Ok(None);
            };
            let proxy = self.1 == services::ServiceRuntime::OllamaProxy;
            let (model, authenticated) = served(contract, proxy)?;
            let source = if authenticated {
                let source =
                    nemoclaw_docker::credentials::Source::observe(engine, id, proxy, sandbox)
                        .await?;
                serde_json::to_string(&source)
                    .map_err(|_| Error::State("cannot encode credential source"))?
            } else {
                String::new()
            };
            Ok(Some(server_ref(sandbox.clone(), model, source)))
        }
        .await;
        match work {
            Ok(reference) => {
                config.ready = Value::Value(true);
                config.reference = reference.map_or(Value::Null, Value::Value);
                Some(config)
            }
            Err(error) => {
                diags.root_error("Service readiness observation failed", error.to_string());
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each runtime's readiness reads only that runtime's contracts, and says
    /// which runtime a mismatched contract belongs to without echoing it.
    #[tokio::test]
    async fn readiness_rejects_another_runtimes_contract() {
        use services::ServiceRuntime::{Ollama, OllamaProxy, Vllm};
        for (runtime, contract, expected) in [
            (
                Ollama,
                r#"{"kind":"vllm","PRIVATE_SENTINEL":1}"#,
                "a vLLM contract",
            ),
            (
                Vllm,
                r#"{"kind":"ollama","PRIVATE_SENTINEL":1}"#,
                "an Ollama contract",
            ),
            (
                Vllm,
                r#"{"upstream":"PRIVATE_SENTINEL"}"#,
                "an Ollama proxy contract",
            ),
            (
                OllamaProxy,
                r#"{"kind":"ollama","PRIVATE_SENTINEL":1}"#,
                "an Ollama contract",
            ),
        ] {
            let source = ReadinessDataSource(Arc::new(ConfiguredBackend::default()), runtime);
            let mut diags = Diagnostics::default();
            let state = ReadinessState {
                engine: Value::Value("unix:///var/run/docker.sock".into()),
                name: Value::Value("qwen".into()),
                contract: Value::Value(contract.into()),
                container_id: Value::Unknown,
                ..Default::default()
            };
            assert!(source.validate(&mut diags, state).await.is_none());
            let message = format!("{diags:?}");
            assert!(message.contains(expected), "{message}");
            assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
        }
    }
    #[tokio::test]
    async fn readiness_validates_offline_and_defers_unknowns_without_echoing_inputs() {
        let source = ReadinessDataSource(
            Arc::new(ConfiguredBackend::default()),
            services::ServiceRuntime::Vllm,
        );
        for (contract, id, timeout, valid) in [
            (Value::Unknown, Value::Unknown, Value::Unknown, true),
            (
                Value::Unknown,
                Value::Value("id".into()),
                Value::Value(0),
                true,
            ),
            (Value::Unknown, Value::Null, Value::Null, false),
            (Value::Null, Value::Unknown, Value::Null, false),
            (Value::Unknown, Value::Unknown, Value::Value(32401), false),
            (
                Value::Value("PRIVATE_SENTINEL".into()),
                Value::Unknown,
                Value::Null,
                false,
            ),
        ] {
            let mut diags = Diagnostics::default();
            assert_eq!(
                source
                    .validate(
                        &mut diags,
                        ReadinessState {
                            engine: Value::Value("unix:///var/run/docker.sock".into()),
                            name: Value::Value("qwen".into()),
                            contract,
                            container_id: id,
                            wait_timeout_seconds: timeout,
                            ..Default::default()
                        }
                    )
                    .await
                    .is_some(),
                valid
            );
            assert!(!format!("{diags:?}").contains("PRIVATE_SENTINEL"));
        }
    }
}
