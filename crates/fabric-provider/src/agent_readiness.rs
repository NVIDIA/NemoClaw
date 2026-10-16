// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Waits for a Fabric agent to run the configuration it applied and report ready.

use crate::AgentBridge;
use async_trait::async_trait;
use nemoclaw_backend::{Error, Row};
use nemoclaw_fabric::agent::{CONFIG_SHA256, RESOURCE_TYPE};
use openshell_provider::GatewayClient;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};
use tokio_util::sync::CancellationToken;

/// Data source for a Fabric agent's readiness.
pub struct AgentReadinessDataSource(pub Arc<GatewayClient>);

/// A typed `ref` input.
type Ref = Value<BTreeMap<String, Value<String>>>;

/// What the agent's `ref` carries: `(ref attribute, row field)`. The row
/// names the sandbox by identity, as the bridge reads it.
const AGENT_FIELDS: [(&str, &str); 7] = [
    ("workspace", "workspace"),
    ("sandbox", "name"),
    ("sandbox_id", "sandbox_id"),
    ("owner", "owner"),
    ("generation", "generation"),
    ("name", "agent"),
    (CONFIG_SHA256, CONFIG_SHA256),
];

#[derive(Default, Serialize, Deserialize)]
pub struct AgentReadinessState {
    /// The gateway holding the agent's sandbox, as `data.openshell_gateway`'s `ref`.
    gateway: Ref,
    /// The agent, as `fabric_agent`'s `ref`.
    agent: Ref,
    read_trigger: Value<String>,
    health_json: Value<String>,
    error_message: Value<String>,
    ready: Value<bool>,
}

/// A ref's attributes as row fields; `None` while any is unknown.
fn fields(reference: &Ref, fields: &[(&str, &str)]) -> Result<Option<Row>, Error> {
    let invalid = || Error::State("agent readiness requires an established agent binding");
    let reference = match reference {
        Value::Value(reference) => reference,
        Value::Unknown => return Ok(None),
        Value::Null => return Err(invalid()),
    };
    let mut row = Row::new();
    for (attribute, field) in fields {
        match reference.get(*attribute) {
            Some(Value::Value(value)) if !value.is_empty() => {
                row.insert((*field).to_owned(), value.clone());
            }
            Some(Value::Unknown) => return Ok(None),
            _ => return Err(invalid()),
        }
    }
    Ok(Some(row))
}

/// The agent's row, once its ref is known; rejects a ref of another type.
fn agent(config: &AgentReadinessState) -> Result<Option<Row>, Error> {
    if let Value::Value(reference) = &config.agent
        && !matches!(reference.get(nemoclaw_tofu::REF_TYPE), Some(Value::Value(kind)) if kind == RESOURCE_TYPE)
    {
        return Err(Error::State("agent readiness takes a fabric_agent ref"));
    }
    fields(&config.agent, &AGENT_FIELDS)
}

/// The gateway ref as the row fields a gateway client reads.
fn gateway_row(config: &AgentReadinessState) -> Result<Row, Error> {
    let Value::Value(gateway) = &config.gateway else {
        return Err(Error::State("agent readiness gateway is not yet known"));
    };
    nemoclaw_openshell::GATEWAY_FIELDS
        .iter()
        .map(|(attribute, field)| match gateway.get(*attribute) {
            Some(Value::Value(value)) => Ok(((*field).to_owned(), value.clone())),
            None | Some(Value::Null) => Ok(((*field).to_owned(), String::new())),
            Some(Value::Unknown) => Err(Error::State("agent readiness gateway is not yet known")),
        })
        .collect()
}

fn object(names: impl IntoIterator<Item = &'static str>) -> AttributeType {
    AttributeType::Object(
        std::iter::once(nemoclaw_tofu::REF_TYPE)
            .chain(names)
            .map(|name| (name.to_owned(), AttributeType::String))
            .collect(),
    )
}

#[async_trait]
impl DataSource for AgentReadinessDataSource {
    type State<'a> = AgentReadinessState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    (
                        "gateway",
                        object(nemoclaw_openshell::GATEWAY_FIELDS.map(|(attribute, _)| attribute)),
                        Required,
                    ),
                    (
                        "agent",
                        object(AGENT_FIELDS.map(|(attribute, _)| attribute)),
                        Required,
                    ),
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
        config: AgentReadinessState,
    ) -> Option<()> {
        match agent(&config) {
            Ok(_) => Some(()),
            Err(error) => {
                diags.root_error("Invalid agent readiness requirements", error.to_string());
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        _diags: &mut Diagnostics,
        mut config: AgentReadinessState,
        _: ValueEmpty,
    ) -> Option<AgentReadinessState> {
        let work = async {
            let agent =
                agent(&config)?.ok_or(Error::State("agent readiness inputs are not yet known"))?;
            if matches!(config.read_trigger, Value::Unknown) {
                return Err(Error::State(
                    "agent readiness read trigger is not yet known",
                ));
            }
            let client = self.0.client_for(&gateway_row(&config)?).await?;
            let mut binding = crate::configuration::bound_sandbox(&client, &agent).await?;
            // The sandbox launches one agent; readiness is about that one.
            if binding.get("agent_name") != agent.get("agent") {
                return Err(nemoclaw_backend::ObservationError::BindingMismatch.into());
            }
            binding.insert(CONFIG_SHA256.into(), agent[CONFIG_SHA256].clone());
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
                let sandbox = match &config.agent {
                    Value::Value(reference) => match reference.get("sandbox") {
                        Some(Value::Value(name)) => Some(name.clone()),
                        _ => None,
                    },
                    _ => None,
                };
                config.error_message = Value::Value(match error {
                    Error::Observation(error) => {
                        nemoclaw_tofu::observation_message(error, sandbox.as_deref())
                    }
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

    fn known(value: &str) -> Value<String> {
        Value::Value(value.to_owned())
    }

    fn reference() -> BTreeMap<String, Value<String>> {
        std::iter::once((nemoclaw_tofu::REF_TYPE, RESOURCE_TYPE))
            .chain([
                ("workspace", "default"),
                ("sandbox", "coder"),
                ("sandbox_id", "sandbox-id"),
                ("owner", "owner"),
                ("generation", "generation"),
                ("name", "main"),
                (CONFIG_SHA256, "sha256:00"),
            ])
            .map(|(name, value)| (name.to_owned(), known(value)))
            .collect()
    }

    fn named(agent: BTreeMap<String, Value<String>>) -> AgentReadinessState {
        AgentReadinessState {
            agent: Value::Value(agent),
            ..Default::default()
        }
    }

    #[test]
    fn the_bridge_reads_the_sandbox_by_identity_and_the_agent_by_name() {
        let row = agent(&named(reference())).unwrap().unwrap();
        assert_eq!(row["name"], "coder");
        assert_eq!(row["sandbox_id"], "sandbox-id");
        assert_eq!(row["agent"], "main");
        assert_eq!(row[CONFIG_SHA256], "sha256:00");
    }

    #[tokio::test]
    async fn every_ref_attribute_is_required_and_unknown_ones_defer() {
        let source = AgentReadinessDataSource(Arc::new(GatewayClient::default()));
        let mut diagnostics = Diagnostics::default();
        assert!(
            source
                .validate(&mut diagnostics, named(reference()))
                .await
                .is_some()
        );
        let mut unknown = named(reference());
        unknown.agent = Value::Unknown;
        assert!(source.validate(&mut diagnostics, unknown).await.is_some());
        for (name, _) in AGENT_FIELDS {
            for (value, valid) in [
                (Value::Unknown, true),
                (Value::Null, false),
                (known(""), false),
            ] {
                let mut agent = reference();
                agent.insert(name.to_owned(), value);
                let mut diagnostics = Diagnostics::default();
                assert_eq!(
                    source
                        .validate(&mut diagnostics, named(agent))
                        .await
                        .is_some(),
                    valid,
                    "{name}"
                );
            }
        }
        let mut other = reference();
        other.insert(
            nemoclaw_tofu::REF_TYPE.to_owned(),
            known("openshell_sandbox"),
        );
        assert!(
            source
                .validate(&mut diagnostics, named(other))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn rejected_inputs_are_not_echoed() {
        let source = AgentReadinessDataSource(Arc::new(GatewayClient::default()));
        let mut agent = reference();
        agent.insert("sandbox_id".into(), Value::Null);
        agent.insert("owner".into(), known("PRIVATE_SENTINEL"));
        let mut diagnostics = Diagnostics::default();
        assert!(
            source
                .validate(&mut diagnostics, named(agent))
                .await
                .is_none()
        );
        assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
    }
}
