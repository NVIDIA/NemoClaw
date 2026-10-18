// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The gateway's version and compute drivers, read over its authenticated API.

use crate::client::{GatewayClient, GatewaySettings};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// Data source for the gateway's version and compute drivers.
pub struct GatewayDataSource(pub Arc<GatewayClient>);

#[derive(Default, Serialize, Deserialize)]
pub struct GatewayState {
    endpoint: Value<String>,
    credential_env: Value<String>,
    tls_ca_env: Value<String>,
    tls_certificate_env: Value<String>,
    tls_key_env: Value<String>,
    /// A managed Kubernetes gateway's specification, from which providers
    /// connect to it themselves.
    kubernetes: Value<String>,
    /// How resources reach this gateway, which they take as `gateway`.
    #[serde(rename = "ref")]
    reference: Value<BTreeMap<String, Value<String>>>,
    required_compute_drivers: Value<Vec<Value<String>>>,
    wait_timeout_seconds: Value<u64>,
    // An unknown scheduling input makes OpenTofu defer this read until apply.
    read_trigger: Value<bool>,
    gateway_version: Value<String>,
    compute_drivers: Value<BTreeSet<String>>,
    compute_driver_count: Value<u64>,
    compatible: Value<bool>,
    observation_json: Value<String>,
    status: Value<String>,
    incompatibility: Value<String>,
}

impl GatewayState {
    fn settings(&self) -> GatewaySettings<'_> {
        GatewaySettings {
            endpoint: &self.endpoint,
            credential_env: &self.credential_env,
            tls_ca_env: &self.tls_ca_env,
            tls_certificate_env: &self.tls_certificate_env,
            tls_key_env: &self.tls_key_env,
            kubernetes: &self.kubernetes,
        }
    }
    /// The `ref` naming this connection; unknown inputs leave it unknown.
    fn reference(&self) -> Value<BTreeMap<String, Value<String>>> {
        if self.settings().unknown() {
            return Value::Unknown;
        }
        let text = |value: &Value<String>| match value {
            Value::Value(value) => value.clone(),
            _ => String::new(),
        };
        let inputs = [
            &self.endpoint,
            &self.credential_env,
            &self.tls_ca_env,
            &self.tls_certificate_env,
            &self.tls_key_env,
            &self.kubernetes,
        ];
        Value::Value(
            std::iter::once((
                nemoclaw_tofu::REF_TYPE.to_owned(),
                Value::Value(nemoclaw_openshell::GATEWAY_TYPE.to_owned()),
            ))
            .chain(nemoclaw_openshell::GATEWAY_FIELDS.iter().zip(inputs).map(
                |((attribute, _), value)| ((*attribute).to_owned(), Value::Value(text(value))),
            ))
            .collect(),
        )
    }
}

fn requirements(diags: &mut Diagnostics, config: &GatewayState) -> Option<()> {
    if !config.settings().unknown()
        && let Err(error) = config.settings().connection()
    {
        diags.error_short(error, AttributePath::new("tls_ca_env"));
        return None;
    }
    let valid = match &config.required_compute_drivers {
        Value::Unknown => true,
        Value::Value(drivers) => {
            !drivers.is_empty()
                && drivers.iter().all(|driver| match driver {
                    Value::Unknown => true,
                    Value::Value(driver) => {
                        driver.parse::<nemoclaw_openshell::ComputeDriver>().is_ok()
                    }
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
    if matches!(config.wait_timeout_seconds, Value::Value(seconds) if seconds > 300) {
        diags.error(
            "Invalid gateway wait",
            "Use a timeout from 0 to 300 seconds.",
            AttributePath::new("wait_timeout_seconds"),
        );
        return None;
    }
    Some(())
}

pub use nemoclaw_openshell::observe_with_wait;

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
                        "endpoint",
                        AttributeType::String,
                        AttributeConstraint::Required,
                    ),
                    (
                        "credential_env",
                        AttributeType::String,
                        AttributeConstraint::Optional,
                    ),
                    (
                        "tls_ca_env",
                        AttributeType::String,
                        AttributeConstraint::Optional,
                    ),
                    (
                        "tls_certificate_env",
                        AttributeType::String,
                        AttributeConstraint::Optional,
                    ),
                    (
                        "tls_key_env",
                        AttributeType::String,
                        AttributeConstraint::Optional,
                    ),
                    (
                        "kubernetes",
                        AttributeType::String,
                        AttributeConstraint::Optional,
                    ),
                    (
                        "ref",
                        AttributeType::Object(
                            std::iter::once(nemoclaw_tofu::REF_TYPE)
                                .chain(
                                    nemoclaw_openshell::GATEWAY_FIELDS
                                        .map(|(attribute, _)| attribute),
                                )
                                .map(|name| (name.to_owned(), AttributeType::String))
                                .collect(),
                        ),
                        AttributeConstraint::Computed,
                    ),
                    (
                        "wait_timeout_seconds",
                        AttributeType::Number,
                        AttributeConstraint::Optional,
                    ),
                    (
                        "read_trigger",
                        AttributeType::Bool,
                        AttributeConstraint::Optional,
                    ),
                    (
                        "required_compute_drivers",
                        AttributeType::Set(Box::new(AttributeType::String)),
                        AttributeConstraint::Required,
                    ),
                    (
                        "observation_json",
                        AttributeType::String,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "status",
                        AttributeType::String,
                        AttributeConstraint::Computed,
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
                        "compute_driver_count",
                        AttributeType::Number,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "compatible",
                        AttributeType::Bool,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "incompatibility",
                        AttributeType::String,
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
        if matches!(config.read_trigger, Value::Unknown) {
            diags.root_error_short("Gateway read trigger is not yet known");
            return None;
        }
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
        let timeout = match config.wait_timeout_seconds {
            Value::Null => 0,
            Value::Value(seconds) => seconds,
            Value::Unknown => {
                diags.root_error_short("Gateway wait is not yet known");
                return None;
            }
        };
        let connection = match config.settings().connection() {
            Ok(Some(connection)) => connection,
            Ok(None) => {
                diags.root_error_short("Gateway endpoint is not yet known");
                return None;
            }
            Err(error) => {
                diags.root_error_short(error);
                return None;
            }
        };
        config.reference = config.reference();
        let observed = match self.0.connect(&connection).await {
            Err(error) => {
                diags.root_error("Gateway connection", error);
                return None;
            }
            Ok(client) => {
                observe_with_wait(Duration::from_secs(timeout), || {
                    client.gateway_capabilities()
                })
                .await
            }
        };
        match observed {
            Ok(observed) => {
                let required = drivers
                    .iter()
                    .map(|driver| driver.parse())
                    .collect::<Result<Vec<_>, _>>()
                    .ok()?;
                let observation = nemoclaw_openshell::GatewayObservation::from_result(
                    Ok(observed.clone()),
                    &required,
                );
                config.status = Value::Value(
                    if observation.compatible == Some(true) {
                        "available"
                    } else {
                        "unavailable"
                    }
                    .into(),
                );
                config.observation_json = Value::Value(serde_json::to_string(&observation).ok()?);
                let incompatibility = observed.incompatibility(drivers.iter().copied());
                config.compatible = Value::Value(incompatibility.is_none());
                // OpenTofu formats condition messages even when the condition holds.
                config.incompatibility = Value::Value(incompatibility.unwrap_or_default());
                config.compute_driver_count = Value::Value(observed.compute_drivers.len() as u64);
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
        let source = GatewayDataSource(Arc::new(GatewayClient::default()));
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
                wait_timeout_seconds: Value::Null,
                read_trigger: Value::Null,
                gateway_version: Value::Null,
                compute_drivers: Value::Null,
                compute_driver_count: Value::Null,
                compatible: Value::Null,
                observation_json: Value::Null,
                status: Value::Null,
                incompatibility: Value::Null,
                ..Default::default()
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

#[cfg(test)]
mod wait_tests {
    use super::*;
    use nemoclaw_backend::ObservationError;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn wait_timeout_is_optional_deferred_or_bounded() {
        let source = GatewayDataSource(Arc::new(GatewayClient::default()));
        for (timeout, valid) in [
            (Value::Null, true),
            (Value::Unknown, true),
            (Value::Value(0), true),
            (Value::Value(300), true),
            (Value::Value(301), false),
        ] {
            let config = GatewayState {
                required_compute_drivers: Value::Value(vec![Value::Value("docker".into())]),
                wait_timeout_seconds: timeout,
                read_trigger: Value::Null,
                gateway_version: Value::Null,
                compute_drivers: Value::Null,
                compute_driver_count: Value::Null,
                compatible: Value::Null,
                observation_json: Value::Null,
                status: Value::Null,
                incompatibility: Value::Null,
                ..Default::default()
            };
            let mut diagnostics = Diagnostics::default();
            assert_eq!(
                source.validate(&mut diagnostics, config).await.is_some(),
                valid
            );
        }
    }

    #[tokio::test]
    async fn waits_only_for_transport_and_bounds_stalled_observations() {
        let calls = AtomicUsize::new(0);
        let result = observe_with_wait(Duration::from_secs(2), || {
            std::future::ready(if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(ObservationError::Transport)
            } else {
                Ok("ready")
            })
        })
        .await;
        assert_eq!(result.unwrap(), "ready");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        for error in [
            ObservationError::Authentication,
            ObservationError::Permission,
            ObservationError::Query,
            ObservationError::Incomplete,
        ] {
            let calls = AtomicUsize::new(0);
            assert_eq!(
                observe_with_wait::<(), _>(Duration::from_secs(2), || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    std::future::ready(Err(error.clone()))
                })
                .await
                .unwrap_err(),
                error
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
        let calls = AtomicUsize::new(0);
        assert!(
            observe_with_wait::<(), _>(Duration::ZERO, || {
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Err(ObservationError::Transport))
            })
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            observe_with_wait::<(), _>(Duration::from_millis(20), std::future::pending)
                .await
                .unwrap_err(),
            ObservationError::Transport
        );
    }
}
