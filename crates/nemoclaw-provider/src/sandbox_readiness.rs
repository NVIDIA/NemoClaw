// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_sdk::{CancellationToken, Error, backend::Row};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct SandboxReadinessDataSource(pub Arc<ConfiguredBackend>);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct SandboxReadinessState {
    sandbox: Value<BTreeMap<String, Value<String>>>,
    read_trigger: Value<String>,
    health_json: Value<String>,
    error_message: Value<String>,
    ready: Value<bool>,
}
fn validate(config: &SandboxReadinessState) -> Result<(), Error> {
    match &config.sandbox {
        Value::Unknown => Ok(()),
        Value::Value(binding)
            if [
                "id",
                "name",
                "workspace",
                "owner",
                "generation",
                "agent_name",
                "agent_runtime",
            ]
            .iter()
            .all(|name| {
                matches!(binding.get(*name), Some(Value::Unknown))
                    || matches!(binding.get(*name), Some(Value::Value(value)) if !value.is_empty())
            }) =>
        {
            Ok(())
        }
        _ => Err(Error::State(
            "sandbox readiness requires an established sandbox binding",
        )),
    }
}
#[async_trait]
impl DataSource for SandboxReadinessDataSource {
    type State<'a> = SandboxReadinessState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, Map, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("sandbox", Map(Box::new(String)), Required),
                    ("read_trigger", String, Optional),
                    ("health_json", String, Computed),
                    ("error_message", String, Computed),
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
    async fn validate<'a>(
        &self,
        diags: &mut Diagnostics,
        config: SandboxReadinessState,
    ) -> Option<()> {
        match validate(&config) {
            Ok(()) => Some(()),
            Err(error) => {
                diags.root_error("Invalid sandbox readiness requirements", error.to_string());
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        _diags: &mut Diagnostics,
        mut config: SandboxReadinessState,
        _: ValueEmpty,
    ) -> Option<SandboxReadinessState> {
        let work = async {
            validate(&config)?;
            let Value::Value(binding) = &config.sandbox else {
                return Err(Error::State("sandbox readiness identity is not yet known"));
            };
            if matches!(config.read_trigger, Value::Unknown) {
                return Err(Error::State(
                    "sandbox readiness read trigger is not yet known",
                ));
            }
            let binding = binding
                .iter()
                .filter(|(_, value)| !matches!(value, Value::Null))
                .map(|(key, value)| match value {
                    Value::Value(value) => Ok((key.clone(), value.clone())),
                    _ => Err(Error::State("sandbox readiness inputs are not yet known")),
                })
                .collect::<Result<Row, Error>>()?;
            let client = self.0.client()?;
            client.ready(&binding, &CancellationToken::new()).await?;
            client.health(&binding).await
        }
        .await;
        match work {
            Ok(health) => {
                config.error_message = Value::Null;
                config.ready = Value::Value(health.allows_apply_completion());
                config.health_json =
                    Value::Value(serde_json::to_string(&health).expect("typed runtime health"));
                Some(config)
            }
            Err(error) => {
                // Observation failures are values: the graph's postcondition
                // rejects completion while retaining the failure and bindings.
                config.ready = Value::Value(false);
                config.health_json = Value::Null;
                config.error_message = Value::Value(error.to_string());
                Some(config)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn offline_validation_defers_unknown_bindings_and_rejects_missing_identity() {
        let source = SandboxReadinessDataSource(Arc::new(ConfiguredBackend::default()));
        for (sandbox, valid) in [
            (Value::Unknown, true),
            (Value::Null, false),
            (Value::Value(BTreeMap::new()), false),
            (
                Value::Value([("id".into(), Value::Value("PRIVATE_SENTINEL".into()))].into()),
                false,
            ),
        ] {
            let mut diagnostics = Diagnostics::default();
            assert_eq!(
                source
                    .validate(
                        &mut diagnostics,
                        SandboxReadinessState {
                            sandbox,
                            ..Default::default()
                        }
                    )
                    .await
                    .is_some(),
                valid
            );
            assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
        }
    }
}
