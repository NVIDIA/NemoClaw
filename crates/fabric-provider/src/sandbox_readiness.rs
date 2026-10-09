// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Waits for a sandbox's Fabric runtime to report ready.

use crate::AgentBridge;
use async_trait::async_trait;
use nemoclaw_backend::{Error, Row};
use openshell_provider::GatewayClient;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};
use tokio_util::sync::CancellationToken;

/// Data source for a sandbox's Fabric runtime readiness.
pub struct SandboxReadinessDataSource(pub Arc<GatewayClient>);

/// The sandbox and configuration attributes readiness reads, in schema order:
/// the sandbox's location and identity, its agent runtime, and the
/// configuration the host must report.
const BINDING: [&str; 9] = [
    "workspace",
    "name",
    "id",
    "owner",
    "generation",
    "agent_name",
    "agent_runtime",
    "runtime_json",
    "config_json",
];

#[derive(Default, Serialize, Deserialize)]
pub struct SandboxReadinessState {
    workspace: Value<String>,
    name: Value<String>,
    id: Value<String>,
    owner: Value<String>,
    generation: Value<String>,
    agent_name: Value<String>,
    agent_runtime: Value<String>,
    runtime_json: Value<String>,
    config_json: Value<String>,
    read_trigger: Value<String>,
    health_json: Value<String>,
    error_message: Value<String>,
    ready: Value<bool>,
}

impl SandboxReadinessState {
    #[cfg(test)]
    fn field(&mut self, name: &str) -> &mut Value<String> {
        match name {
            "workspace" => &mut self.workspace,
            "name" => &mut self.name,
            "id" => &mut self.id,
            "owner" => &mut self.owner,
            "generation" => &mut self.generation,
            "agent_name" => &mut self.agent_name,
            "agent_runtime" => &mut self.agent_runtime,
            "runtime_json" => &mut self.runtime_json,
            "config_json" => &mut self.config_json,
            _ => unreachable!("readiness has no input named {name}"),
        }
    }
    fn inputs(&self) -> [&Value<String>; 9] {
        [
            &self.workspace,
            &self.name,
            &self.id,
            &self.owner,
            &self.generation,
            &self.agent_name,
            &self.agent_runtime,
            &self.runtime_json,
            &self.config_json,
        ]
    }
}

fn validate(config: &SandboxReadinessState) -> Result<(), Error> {
    // Unknown inputs come from resources not yet applied; reads defer.
    if config.inputs().iter().all(|value| {
        matches!(value, Value::Unknown) || matches!(value, Value::Value(value) if !value.is_empty())
    }) {
        Ok(())
    } else {
        Err(Error::State(
            "sandbox readiness requires an established sandbox binding",
        ))
    }
}

/// The row the Fabric bridge reads, once every input is known.
fn binding(config: &SandboxReadinessState) -> Result<Row, Error> {
    BINDING
        .iter()
        .zip(config.inputs())
        .map(|(name, value)| match value {
            Value::Value(value) => Ok(((*name).to_owned(), value.clone())),
            _ => Err(Error::State("sandbox readiness inputs are not yet known")),
        })
        .collect()
}

#[async_trait]
impl DataSource for SandboxReadinessDataSource {
    type State<'a> = SandboxReadinessState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: BINDING
                    .iter()
                    .map(|name| (*name, String, Required))
                    .chain([
                        ("read_trigger", String, Optional),
                        ("health_json", String, Computed),
                        ("error_message", String, Computed),
                        ("ready", Bool, Computed),
                    ])
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
            if matches!(config.read_trigger, Value::Unknown) {
                return Err(Error::State(
                    "sandbox readiness read trigger is not yet known",
                ));
            }
            let binding = binding(&config)?;
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
                let sandbox = match &config.name {
                    Value::Value(name) => Some(name.as_str()),
                    _ => None,
                };
                config.error_message = Value::Value(match error {
                    Error::Observation(error) => nemoclaw_tofu::observation_message(error, sandbox),
                    other => other.to_string(),
                });
                Some(config)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named() -> SandboxReadinessState {
        let known = |value: &str| Value::Value(value.to_owned());
        SandboxReadinessState {
            workspace: known("default"),
            name: known("coder"),
            id: known("sandbox-id"),
            owner: known("owner"),
            generation: known("generation"),
            agent_name: known("coder"),
            agent_runtime: known("fabric"),
            runtime_json: known("{}"),
            config_json: known("{}"),
            ..Default::default()
        }
    }

    #[test]
    fn readiness_takes_the_sandbox_and_configuration_it_reads_by_name() {
        let schema = SandboxReadinessDataSource(Arc::new(GatewayClient::default()))
            .schema(&mut Diagnostics::default())
            .unwrap();
        assert!(!schema.block.attributes.contains_key("sandbox"));
        for name in BINDING {
            assert!(
                matches!(
                    schema.block.attributes[name].constraint,
                    AttributeConstraint::Required
                ),
                "{name}"
            );
        }
        // The row handed to the bridge holds exactly the named inputs.
        let row = binding(&named()).unwrap();
        assert_eq!(row.keys().map(String::as_str).collect::<Vec<_>>(), {
            let mut names = BINDING.to_vec();
            names.sort_unstable();
            names
        });
    }

    #[tokio::test]
    async fn every_named_input_is_required_and_unknown_ones_defer() {
        let source = SandboxReadinessDataSource(Arc::new(GatewayClient::default()));
        let mut diagnostics = Diagnostics::default();
        assert!(source.validate(&mut diagnostics, named()).await.is_some());
        for name in BINDING {
            for (value, valid) in [
                (Value::Unknown, true),
                (Value::Null, false),
                (Value::Value(String::new()), false),
            ] {
                let mut config = named();
                *config.field(name) = value;
                let mut diagnostics = Diagnostics::default();
                assert_eq!(
                    source.validate(&mut diagnostics, config).await.is_some(),
                    valid,
                    "{name}"
                );
            }
        }
    }

    #[tokio::test]
    async fn rejected_inputs_are_not_echoed() {
        let source = SandboxReadinessDataSource(Arc::new(GatewayClient::default()));
        let config = SandboxReadinessState {
            id: Value::Value("PRIVATE_SENTINEL".into()),
            ..Default::default()
        };
        let mut diagnostics = Diagnostics::default();
        assert!(source.validate(&mut diagnostics, config).await.is_none());
        assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
    }
}
