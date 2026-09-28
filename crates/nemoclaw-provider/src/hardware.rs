// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_sdk::{
    discovery::ObservationStatus, docker::Engine, hardware_discovery::observe_hardware,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct HardwareDataSource(pub Arc<ConfiguredBackend>);
#[derive(Serialize, Deserialize)]
pub(crate) struct HardwareState {
    engine: Value<String>,
    observation_json: Value<String>,
    available: Value<bool>,
    status: Value<String>,
}

fn valid(config: &HardwareState) -> bool {
    match &config.engine {
        Value::Unknown => true,
        Value::Value(engine) => Engine::validate_endpoint(engine).is_ok(),
        Value::Null => false,
    }
}

#[async_trait]
impl DataSource for HardwareDataSource {
    type State<'a> = HardwareState;
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
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: HardwareState) -> Option<()> {
        if valid(&config) {
            Some(())
        } else {
            diags.root_error_short("Invalid hardware discovery target");
            None
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: HardwareState,
        _: ValueEmpty,
    ) -> Option<HardwareState> {
        if !valid(&config) {
            diags.root_error_short("Invalid hardware discovery target");
            return None;
        }
        let Value::Value(engine) = &config.engine else {
            config.observation_json = Value::Unknown;
            config.available = Value::Unknown;
            config.status = Value::Unknown;
            return Some(config);
        };
        let observation = observe_hardware(self.0.connections(), engine).await;
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
                diags.root_error_short("Hardware observation could not be encoded");
                return None;
            }
        }
        Some(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(engine: Value<String>) -> HardwareState {
        HardwareState {
            engine,
            observation_json: Value::Null,
            available: Value::Null,
            status: Value::Null,
        }
    }
    #[tokio::test]
    async fn unknown_target_defers_all_outputs_and_transport_failure_is_a_completed_unknown_observation()
     {
        let source = HardwareDataSource(Arc::new(ConfiguredBackend::default()));
        let mut diagnostics = Diagnostics::default();
        let result = source
            .read(
                &mut diagnostics,
                state(Value::Unknown),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(matches!(result.status, Value::Unknown));
        assert!(matches!(result.observation_json, Value::Unknown));
        let result = source
            .read(
                &mut diagnostics,
                state(Value::Value("unix:///missing-hardware.sock".into())),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(matches!(result.status, Value::Value(ref status) if status == "unknown"));
        assert!(matches!(result.available, Value::Value(false)));
        assert!(diagnostics.errors.is_empty());
    }
}
