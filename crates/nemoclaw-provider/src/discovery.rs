// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_sdk::{
    discovery::{DiscoveryRequest, ObservationStatus, observe_engine, observe_fabric},
    docker::Engine,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct DiscoveryDataSource {
    pub backend: Arc<ConfiguredBackend>,
    pub fabric: bool,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct DiscoveryState {
    engine: Value<String>,
    #[serde(default, skip_serializing_if = "is_null")]
    compute_driver: Value<String>,
    #[serde(default, skip_serializing_if = "is_null")]
    image: Value<String>,
    observation_json: Value<String>,
    available: Value<bool>,
    status: Value<String>,
}
fn is_null<T>(value: &Value<T>) -> bool {
    matches!(value, Value::Null)
}
impl DiscoveryDataSource {
    fn valid(&self, config: &DiscoveryState) -> bool {
        let engine_valid = match &config.engine {
            Value::Unknown => true,
            Value::Value(engine) => Engine::validate_endpoint(engine).is_ok(),
            Value::Null => false,
        };
        let selection_valid = if self.fabric {
            matches!(&config.image, Value::Unknown)
                || matches!(&config.image,Value::Value(image) if !image.is_empty())
        } else {
            matches!(&config.compute_driver, Value::Unknown)
                || matches!(&config.compute_driver,Value::Value(driver) if driver=="docker" || driver=="podman")
        };
        engine_valid && selection_valid
    }
}
#[async_trait]
impl DataSource for DiscoveryDataSource {
    type State<'a> = DiscoveryState;
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
                        if self.fabric {
                            "image"
                        } else {
                            "compute_driver"
                        },
                        AttributeType::String,
                        AttributeConstraint::Required,
                    ),
                    (
                        "observation_json",
                        AttributeType::String,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "available",
                        AttributeType::Bool,
                        AttributeConstraint::Computed,
                    ),
                    (
                        "status",
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
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: DiscoveryState) -> Option<()> {
        if self.valid(&config) {
            Some(())
        } else {
            diags.root_error_short("Invalid discovery target or selection");
            None
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: DiscoveryState,
        _: ValueEmpty,
    ) -> Option<DiscoveryState> {
        if !self.valid(&config) {
            diags.root_error_short("Invalid discovery target or selection");
            return None;
        }
        let Value::Value(engine) = &config.engine else {
            config.observation_json = Value::Unknown;
            config.available = Value::Unknown;
            return Some(config);
        };
        let (status, json) = if self.fabric {
            let Value::Value(image) = &config.image else {
                config.observation_json = Value::Unknown;
                config.available = Value::Unknown;
                return Some(config);
            };
            let observation = observe_fabric(self.backend.connections(), engine, image).await;
            (observation.status, serde_json::to_string(&observation))
        } else {
            let Value::Value(driver) = &config.compute_driver else {
                config.observation_json = Value::Unknown;
                config.available = Value::Unknown;
                return Some(config);
            };
            let observation = observe_engine(
                self.backend.connections(),
                &DiscoveryRequest {
                    engine: engine.clone(),
                    compute_driver: driver.parse().ok()?,
                },
            )
            .await;
            (observation.status, serde_json::to_string(&observation))
        };
        config.available = match status {
            ObservationStatus::Available => Value::Value(true),
            ObservationStatus::Unavailable => Value::Value(false),
            ObservationStatus::Unknown => Value::Value(false),
        };
        config.status = Value::Value(
            match status {
                ObservationStatus::Available => "available",
                ObservationStatus::Unavailable => "unavailable",
                ObservationStatus::Unknown => "unknown",
            }
            .into(),
        );
        match json {
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

    fn engine_config() -> DiscoveryState {
        DiscoveryState {
            engine: Value::Value("unix:///does-not-exist/nemoclaw.sock".into()),
            compute_driver: Value::Value("docker".into()),
            image: Value::Null,
            observation_json: Value::Null,
            available: Value::Null,
            status: Value::Null,
        }
    }

    #[tokio::test]
    async fn unavailable_transport_returns_completed_unknown_observation_without_provider_error() {
        let source = DiscoveryDataSource {
            backend: Arc::new(ConfiguredBackend::default()),
            fabric: false,
        };
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
        let source = DiscoveryDataSource {
            backend: Arc::new(ConfiguredBackend::default()),
            fabric: false,
        };
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
}
