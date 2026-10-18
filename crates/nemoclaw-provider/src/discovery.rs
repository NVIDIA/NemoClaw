// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Whether an engine meets a managed gateway's prerequisites for a compute
//! driver. `host_engine` reads the engine's facts.

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_discovery::observe_gateway_prerequisites;
use nemoclaw_sdk::discovery::{DiscoveryRequest, ObservationStatus};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// Data source for whether an engine can host a managed gateway with a
/// compute driver. The gateway installation types enforce the same check.
pub(crate) struct GatewayPrerequisitesDataSource(pub Arc<ConfiguredBackend>);

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct GatewayPrerequisitesState {
    engine: Value<String>,
    compute_driver: Value<String>,
    observation_json: Value<String>,
    available: Value<bool>,
    status: Value<String>,
}

fn engine_valid(engine: &Value<String>) -> bool {
    match engine {
        Value::Unknown => true,
        Value::Value(engine) => crate::config::validate_engine_endpoint(engine).is_ok(),
        Value::Null => false,
    }
}

fn driver_valid(driver: &Value<String>) -> bool {
    match driver {
        Value::Unknown => true,
        Value::Value(driver) => driver == "docker" || driver == "podman",
        Value::Null => false,
    }
}

/// Required string `inputs`, then the observation every engine read reports.
fn schema(inputs: &[&str]) -> Schema {
    use AttributeConstraint::{Computed, Required};
    use AttributeType::{Bool, String};
    Schema {
        version: 0,
        block: Block {
            attributes: inputs
                .iter()
                .map(|name| (*name, String, Required))
                .chain([
                    ("observation_json", String, Computed),
                    ("available", Bool, Computed),
                    ("status", String, Computed),
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
    }
}

/// The observation's outputs: its JSON, whether it is available, and its status.
type Outputs = (Value<String>, Value<bool>, Value<String>);

fn outputs<T: Serialize>(
    diags: &mut Diagnostics,
    observation: &T,
    status: ObservationStatus,
) -> Option<Outputs> {
    let Ok(json) = serde_json::to_string(observation) else {
        diags.root_error_short("Discovery observation could not be encoded");
        return None;
    };
    let name = match status {
        ObservationStatus::Available => "available",
        ObservationStatus::Unavailable => "unavailable",
        ObservationStatus::Unknown => "unknown",
    };
    Some((
        Value::Value(json),
        Value::Value(status == ObservationStatus::Available),
        Value::Value(name.into()),
    ))
}

fn invalid(diags: &mut Diagnostics) {
    diags.root_error_short("Invalid discovery target or selection");
}

#[async_trait]
impl DataSource for GatewayPrerequisitesDataSource {
    type State<'a> = GatewayPrerequisitesState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(schema(&["engine", "compute_driver"]))
    }

    async fn validate<'a>(
        &self,
        diags: &mut Diagnostics,
        config: GatewayPrerequisitesState,
    ) -> Option<()> {
        if engine_valid(&config.engine) && driver_valid(&config.compute_driver) {
            Some(())
        } else {
            invalid(diags);
            None
        }
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: GatewayPrerequisitesState,
        _: ValueEmpty,
    ) -> Option<GatewayPrerequisitesState> {
        if !engine_valid(&config.engine) || !driver_valid(&config.compute_driver) {
            invalid(diags);
            return None;
        }
        let (Value::Value(engine), Value::Value(driver)) = (&config.engine, &config.compute_driver)
        else {
            config.observation_json = Value::Unknown;
            config.available = Value::Unknown;
            config.status = Value::Unknown;
            return Some(config);
        };
        let observation = observe_gateway_prerequisites(
            self.0.connections(),
            &DiscoveryRequest {
                engine: engine.clone(),
                compute_driver: driver.parse().ok()?,
            },
        )
        .await;
        (config.observation_json, config.available, config.status) =
            outputs(diags, &observation, observation.status)?;
        Some(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNREACHABLE: &str = "unix:///does-not-exist/nemoclaw.sock";

    fn prerequisites_config(driver: &str) -> GatewayPrerequisitesState {
        GatewayPrerequisitesState {
            engine: Value::Value(UNREACHABLE.into()),
            compute_driver: Value::Value(driver.into()),
            ..Default::default()
        }
    }

    fn status(json: &Value<String>) -> serde_json::Value {
        let Value::Value(json) = json else {
            panic!("completed observation")
        };
        serde_json::from_str::<serde_json::Value>(json).unwrap()["status"].clone()
    }

    #[tokio::test]
    async fn unavailable_transport_returns_completed_unknown_observation_without_provider_error() {
        let mut diagnostics = Diagnostics::default();
        let prerequisites = GatewayPrerequisitesDataSource(Arc::new(ConfiguredBackend::default()))
            .read(
                &mut diagnostics,
                prerequisites_config("podman"),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(matches!(prerequisites.available, Value::Value(false)));
        assert_eq!(status(&prerequisites.observation_json), "unknown");
        assert!(diagnostics.errors.is_empty());
    }

    #[tokio::test]
    async fn unknown_inputs_validate_without_connecting_and_invalid_values_do_not_leak() {
        let prerequisites = GatewayPrerequisitesDataSource(Arc::new(ConfiguredBackend::default()));
        let mut diagnostics = Diagnostics::default();
        let mut unknown = prerequisites_config("docker");
        unknown.engine = Value::Unknown;
        unknown.compute_driver = Value::Unknown;
        assert!(
            prerequisites
                .validate(&mut diagnostics, unknown)
                .await
                .is_some()
        );
        let invalid = prerequisites_config("PRIVATE_SENTINEL");
        assert!(
            prerequisites
                .validate(&mut diagnostics, invalid)
                .await
                .is_none()
        );
        assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
    }
}
