// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct CapacityDataSource(pub Arc<ConfiguredBackend>);
#[derive(Serialize, Deserialize)]
pub(crate) struct CapacityState {
    engine: Value<String>,
    contracts: Value<Vec<Value<String>>>,
    required_bytes: Value<u64>,
    observed_bytes: Value<u64>,
    compatible: Value<bool>,
}
fn requirements(config: &CapacityState) -> Result<(), nemoclaw_sdk::Error> {
    use crate::{Error, services::validate_capacity_contracts};
    let engine = match &config.engine {
        Value::Value(engine) => {
            crate::config::validate_engine_endpoint(engine)?;
            Some(engine.as_str())
        }
        Value::Unknown => None,
        Value::Null => return Err(Error::Conflict("capacity engine is required")),
    };
    let contracts = match &config.contracts {
        Value::Unknown => return Ok(()),
        Value::Value(contracts) if !contracts.is_empty() => contracts,
        _ => {
            return Err(Error::Conflict(
                "service capacity requires at least one runtime contract",
            ));
        }
    };
    let mut known = Vec::new();
    for contract in contracts {
        match contract {
            Value::Value(contract) => known.push(contract.clone()),
            Value::Unknown => {}
            Value::Null => return Err(Error::Conflict("capacity runtime contract is required")),
        }
    }
    if !known.is_empty() {
        validate_capacity_contracts(engine, &known)?;
    }
    Ok(())
}
#[async_trait]
impl DataSource for CapacityDataSource {
    type State<'a> = CapacityState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    (
                        "engine",
                        AttributeType::String,
                        AttributeConstraint::Required,
                    ),
                    (
                        "contracts",
                        AttributeType::List(Box::new(AttributeType::String)),
                        AttributeConstraint::Required,
                    ),
                    (
                        "required_bytes",
                        AttributeType::Number,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "observed_bytes",
                        AttributeType::Number,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "compatible",
                        AttributeType::Bool,
                        AttributeConstraint::Computed,
                    ),
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
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: CapacityState) -> Option<()> {
        match requirements(&config) {
            Ok(()) => Some(()),
            Err(error) => {
                diags.error(
                    "Invalid service capacity requirements",
                    error.to_string(),
                    AttributePath::new("contracts"),
                );
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: CapacityState,
        _: ValueEmpty,
    ) -> Option<CapacityState> {
        let work = async {
            requirements(&config)?;
            let (Value::Value(engine), Value::Value(contracts)) =
                (&config.engine, &config.contracts)
            else {
                return Err(nemoclaw_sdk::Error::State(
                    "capacity requirements are not yet known",
                ));
            };
            let contracts = contracts
                .iter()
                .map(|contract| match contract {
                    Value::Value(contract) => Ok(contract.clone()),
                    _ => Err(nemoclaw_sdk::Error::State(
                        "capacity requirements are not yet known",
                    )),
                })
                .collect::<Result<Vec<_>, _>>()?;
            crate::services::observe_service_capacity(self.0.connections(), engine, &contracts)
                .await
        }
        .await;
        match work {
            Ok(observed) => {
                config.compatible = Value::Value(observed.compatible());
                config.required_bytes = Value::Value(observed.required_bytes);
                config.observed_bytes = Value::Value(observed.observed_bytes);
                Some(config)
            }
            Err(error) => {
                diags.root_error("Service capacity observation failed", error.to_string());
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn capacity_inputs_validate_offline_and_defer_unknown_values_without_echoing_input() {
        let source = CapacityDataSource(Arc::new(ConfiguredBackend::default()));
        for (engine, contracts, valid) in [
            (Value::Unknown, Value::Unknown, true),
            (
                Value::Value("ssh://gpu-box".into()),
                Value::Value(vec![Value::Unknown]),
                true,
            ),
            (Value::Null, Value::Unknown, false),
            (Value::Unknown, Value::Null, false),
            (Value::Unknown, Value::Value(vec![]), false),
            (Value::Unknown, Value::Value(vec![Value::Null]), false),
            (
                Value::Unknown,
                Value::Value(vec![
                    Value::Value("PRIVATE_SENTINEL".into()),
                    Value::Unknown,
                ]),
                false,
            ),
            (
                Value::Value("PRIVATE_SENTINEL".into()),
                Value::Unknown,
                false,
            ),
        ] {
            let mut diagnostics = Diagnostics::default();
            let result = source
                .validate(
                    &mut diagnostics,
                    CapacityState {
                        engine,
                        contracts,
                        required_bytes: Value::Null,
                        observed_bytes: Value::Null,
                        compatible: Value::Null,
                    },
                )
                .await;
            assert_eq!(result.is_some(), valid);
            assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
        }
    }
}
