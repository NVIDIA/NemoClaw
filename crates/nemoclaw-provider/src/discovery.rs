// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The selected container engine's prerequisites for a compute driver.

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_discovery::observe_engine;
use nemoclaw_sdk::discovery::{DiscoveryRequest, ObservationStatus};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// Data source for whether an engine can run a compute driver.
pub(crate) struct EngineCapabilitiesDataSource(pub Arc<ConfiguredBackend>);

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct EngineCapabilitiesState {
    engine: Value<String>,
    compute_driver: Value<String>,
    observation_json: Value<String>,
    available: Value<bool>,
    status: Value<String>,
}

fn valid(config: &EngineCapabilitiesState) -> bool {
    let engine_valid = match &config.engine {
        Value::Unknown => true,
        Value::Value(engine) => crate::config::validate_engine_endpoint(engine).is_ok(),
        Value::Null => false,
    };
    let driver_valid = match &config.compute_driver {
        Value::Unknown => true,
        Value::Value(driver) => driver == "docker" || driver == "podman",
        Value::Null => false,
    };
    engine_valid && driver_valid
}

#[async_trait]
impl DataSource for EngineCapabilitiesDataSource {
    type State<'a> = EngineCapabilitiesState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Required};
        use AttributeType::{Bool, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("engine", String, Required),
                    ("compute_driver", String, Required),
                    ("observation_json", String, Computed),
                    ("available", Bool, Computed),
                    ("status", String, Computed),
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
        config: EngineCapabilitiesState,
    ) -> Option<()> {
        if valid(&config) {
            Some(())
        } else {
            diags.root_error_short("Invalid discovery target or selection");
            None
        }
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: EngineCapabilitiesState,
        _: ValueEmpty,
    ) -> Option<EngineCapabilitiesState> {
        if !valid(&config) {
            diags.root_error_short("Invalid discovery target or selection");
            return None;
        }
        let (Value::Value(engine), Value::Value(driver)) = (&config.engine, &config.compute_driver)
        else {
            config.observation_json = Value::Unknown;
            config.available = Value::Unknown;
            config.status = Value::Unknown;
            return Some(config);
        };
        let observation = observe_engine(
            self.0.connections(),
            &DiscoveryRequest {
                engine: engine.clone(),
                compute_driver: driver.parse().ok()?,
            },
        )
        .await;
        config.available = Value::Value(observation.status == ObservationStatus::Available);
        config.status = Value::Value(
            match observation.status {
                ObservationStatus::Available => "available",
                ObservationStatus::Unavailable => "unavailable",
                ObservationStatus::Unknown => "unknown",
            }
            .into(),
        );
        match serde_json::to_string(&observation) {
            Ok(json) => config.observation_json = Value::Value(json),
            Err(_) => {
                diags.root_error_short("Discovery observation could not be encoded");
                return None;
            }
        }
        Some(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_config() -> EngineCapabilitiesState {
        EngineCapabilitiesState {
            engine: Value::Value("unix:///does-not-exist/nemoclaw.sock".into()),
            compute_driver: Value::Value("docker".into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn unavailable_transport_returns_completed_unknown_observation_without_provider_error() {
        let source = EngineCapabilitiesDataSource(Arc::new(ConfiguredBackend::default()));
        let mut diagnostics = Diagnostics::default();
        let result = source
            .read(&mut diagnostics, engine_config(), ValueEmpty::default())
            .await
            .unwrap();
        assert!(diagnostics.errors.is_empty());
        assert!(matches!(result.available, Value::Value(false)));
        assert!(matches!(result.status,Value::Value(ref status) if status=="unknown"));
        let Value::Value(json) = result.observation_json else {
            panic!("completed observation")
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap()["status"],
            "unknown"
        );
    }

    #[tokio::test]
    async fn unknown_inputs_validate_without_connecting_and_invalid_values_do_not_leak() {
        let source = EngineCapabilitiesDataSource(Arc::new(ConfiguredBackend::default()));
        let mut diagnostics = Diagnostics::default();
        let mut unknown = engine_config();
        unknown.engine = Value::Unknown;
        unknown.compute_driver = Value::Unknown;
        assert!(source.validate(&mut diagnostics, unknown).await.is_some());
        let mut invalid = engine_config();
        invalid.engine = Value::Value("PRIVATE_SENTINEL".into());
        assert!(source.validate(&mut diagnostics, invalid).await.is_none());
        assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
    }

    #[test]
    fn engine_schema_has_no_fabric_inputs() {
        let schema = EngineCapabilitiesDataSource(Arc::new(ConfiguredBackend::default()))
            .schema(&mut Diagnostics::default())
            .unwrap();
        for field in [
            "image",
            "metadata_env",
            "config_json",
            "filesystem_read",
            "compatibility_status",
        ] {
            assert!(!schema.block.attributes.contains_key(field), "{field}");
        }
        let serialized = serde_json::to_value(engine_config()).unwrap();
        assert_eq!(
            serialized.as_object().unwrap().len(),
            schema.block.attributes.len()
        );
    }
}
