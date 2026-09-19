// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct GatewayDataSource(pub Arc<ConfiguredBackend>);

#[derive(Serialize, Deserialize)]
pub(crate) struct GatewayState {
    required_compute_drivers: Value<Vec<Value<String>>>,
    gateway_version: Value<String>,
    compute_drivers: Value<BTreeSet<String>>,
    compatible: Value<bool>,
}

fn requirements(diags: &mut Diagnostics, config: &GatewayState) -> Option<()> {
    let valid = match &config.required_compute_drivers {
        Value::Unknown => true,
        Value::Value(drivers) => {
            !drivers.is_empty()
                && drivers.iter().all(|driver| match driver {
                    Value::Unknown => true,
                    Value::Value(driver) => matches!(driver.as_str(), "docker" | "podman"),
                    Value::Null => false,
                })
        }
        Value::Null => false,
    };
    if !valid {
        diags.error(
            "Invalid gateway requirements",
            "Select at least one compute driver: docker or podman.",
            AttributePath::new("required_compute_drivers"),
        );
        return None;
    }
    Some(())
}

#[async_trait]
impl DataSource for GatewayDataSource {
    type State<'a> = GatewayState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    (
                        "required_compute_drivers",
                        AttributeType::Set(Box::new(AttributeType::String)),
                        AttributeConstraint::Required,
                    ),
                    (
                        "gateway_version",
                        AttributeType::String,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "compute_drivers",
                        AttributeType::Set(Box::new(AttributeType::String)),
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

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: GatewayState) -> Option<()> {
        requirements(diags, &config)
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: GatewayState,
        _: ValueEmpty,
    ) -> Option<GatewayState> {
        requirements(diags, &config)?;
        let drivers = match &config.required_compute_drivers {
            Value::Value(drivers) => drivers
                .iter()
                .map(|driver| match driver {
                    Value::Value(driver) => Some(driver.as_str()),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>(),
            _ => None,
        };
        let Some(drivers) = drivers else {
            diags.root_error_short("Gateway requirements are not yet known");
            return None;
        };
        let observed = match self.0.client() {
            Ok(client) => client.gateway_capabilities().await,
            Err(error) => Err(error),
        };
        match observed {
            Ok(observed) => {
                config.compatible =
                    Value::Value(drivers.iter().all(|driver| observed.supports(driver)));
                config.gateway_version = Value::Value(observed.gateway_version);
                config.compute_drivers =
                    Value::Value(observed.compute_drivers.into_iter().flatten().collect());
                Some(config)
            }
            Err(error) => {
                diags.root_error("Gateway capability observation failed", error.to_string());
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn gateway_requirements_validate_offline_and_defer_unknown_values() {
        let source = GatewayDataSource(Arc::new(ConfiguredBackend::default()));
        for (drivers, valid) in [
            (Value::Unknown, true),
            (Value::Value(vec![Value::Unknown]), true),
            (Value::Value(vec![Value::Value("docker".into())]), true),
            (Value::Null, false),
            (Value::Value(vec![]), false),
            (Value::Value(vec![Value::Null]), false),
            (
                Value::Value(vec![Value::Value("PRIVATE_SENTINEL".into())]),
                false,
            ),
        ] {
            let config = GatewayState {
                required_compute_drivers: drivers,
                gateway_version: Value::Null,
                compute_drivers: Value::Null,
                compatible: Value::Null,
            };
            let mut diagnostics = Diagnostics::default();
            assert_eq!(
                source.validate(&mut diagnostics, config).await.is_some(),
                valid
            );
            assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
        }
    }
}
