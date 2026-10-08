// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::provider::ConfiguredBackend;
use crate::services;
use async_trait::async_trait;
use nemoclaw_sdk::{CancellationToken, Error};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct ReadinessDataSource(pub Arc<ConfiguredBackend>);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct ReadinessState {
    engine: Value<String>,
    name: Value<String>,
    contract: Value<String>,
    container_id: Value<String>,
    wait_timeout_seconds: Value<u64>,
    read_trigger: Value<bool>,
    ready: Value<bool>,
}
/// The readiness inputs, or `None` while any is unknown.
fn readiness(config: &ReadinessState) -> Result<Option<services::Readiness>, Error> {
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
        [engine, name, contract] => services::Readiness::new(engine, name, contract).map(Some),
        _ => Ok(None),
    }
}
fn validate(config: &ReadinessState) -> Result<(), Error> {
    readiness(config)?;
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
                    ("engine", String, Required),
                    ("name", String, Required),
                    ("contract", String, Required),
                    ("container_id", String, Required),
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
                .collect(),
                ..Default::default()
            },
        })
    }
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: ReadinessState) -> Option<()> {
        match validate(&config) {
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
        let work = async {
            validate(&config)?;
            let (Some(readiness), Value::Value(id)) = (readiness(&config)?, &config.container_id)
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
            .await
        }
        .await;
        match work {
            Ok(()) => {
                config.ready = Value::Value(true);
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
    #[tokio::test]
    async fn readiness_validates_offline_and_defers_unknowns_without_echoing_inputs() {
        let source = ReadinessDataSource(Arc::new(ConfiguredBackend::default()));
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
