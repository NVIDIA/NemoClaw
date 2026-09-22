// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_sdk::ObservationError;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};
use std::{future::Future, time::Duration};
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct GatewayDataSource(pub Arc<ConfiguredBackend>);

#[derive(Serialize, Deserialize)]
pub(crate) struct GatewayState {
    required_compute_drivers: Value<Vec<Value<String>>>,
    wait_timeout_seconds: Value<u64>,
    // An unknown scheduling input makes OpenTofu defer this read until apply.
    read_trigger: Value<bool>,
    gateway_version: Value<String>,
    compute_drivers: Value<BTreeSet<String>>,
    compute_driver_count: Value<u64>,
    compatible: Value<bool>,
}

fn requirements(diags: &mut Diagnostics, config: &GatewayState) -> Option<()> {
    let valid = match &config.required_compute_drivers {
        Value::Unknown => true,
        Value::Value(drivers) => {
            !drivers.is_empty()
                && drivers.iter().all(|driver| match driver {
                    Value::Unknown => true,
                    Value::Value(driver) => driver
                        .parse::<nemoclaw_sdk::config::ComputeDriver>()
                        .is_ok(),
                    Value::Null => false,
                })
        }
        Value::Null => false,
    };
    if !valid {
        diags.error(
            "Invalid gateway requirements",
            "Select at least one compute driver: docker, podman, or kubernetes.",
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

async fn observe_with_wait<T, F: Future<Output = Result<T, ObservationError>>>(
    timeout: Duration,
    mut observe: impl FnMut() -> F,
) -> Result<T, ObservationError> {
    if timeout.is_zero() {
        return observe().await;
    }
    tokio::time::timeout(timeout, async {
        loop {
            match observe().await {
                Err(ObservationError::Transport) => {
                    tokio::time::sleep(Duration::from_millis(200)).await
                }
                result => return result,
            }
        }
    })
    .await
    .unwrap_or(Err(ObservationError::Transport))
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
        let observed = match self.0.client() {
            Ok(client) => {
                observe_with_wait(Duration::from_secs(timeout), || {
                    client.gateway_capabilities()
                })
                .await
            }
            Err(error) => Err(error),
        };
        match observed {
            Ok(observed) => {
                config.compatible =
                    Value::Value(drivers.iter().all(|driver| observed.supports(driver)));
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
        let source = GatewayDataSource(Arc::new(ConfiguredBackend::default()));
        for (drivers, valid) in [
            (Value::Unknown, true),
            (Value::Value(vec![Value::Unknown]), true),
            (Value::Value(vec![Value::Value("docker".into())]), true),
            (Value::Value(vec![Value::Value("podman".into())]), true),
            (Value::Value(vec![Value::Value("kubernetes".into())]), true),
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn wait_timeout_is_optional_deferred_or_bounded() {
        let source = GatewayDataSource(Arc::new(ConfiguredBackend::default()));
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
                    std::future::ready(Err(error))
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
