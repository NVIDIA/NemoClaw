// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `host_engine`: a container engine's facts and advertised hardware, from one
//! read of its API. It never runs a collector or a probe container.
use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_discovery::observe_host;
use nemoclaw_sdk::discovery::ObservationStatus;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct HostEngineDataSource(pub Arc<ConfiguredBackend>);

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct HostEngineState {
    engine: Value<String>,
    engine_json: Value<String>,
    hardware_json: Value<String>,
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

fn invalid(diags: &mut Diagnostics) {
    diags.root_error_short("Invalid engine endpoint");
}

#[async_trait]
impl DataSource for HostEngineDataSource {
    type State<'a> = HostEngineState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Required};
        use AttributeType::{Bool, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("engine", String, Required),
                    ("engine_json", String, Computed),
                    ("hardware_json", String, Computed),
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

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: HostEngineState) -> Option<()> {
        if engine_valid(&config.engine) {
            Some(())
        } else {
            invalid(diags);
            None
        }
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: HostEngineState,
        _: ValueEmpty,
    ) -> Option<HostEngineState> {
        if !engine_valid(&config.engine) {
            invalid(diags);
            return None;
        }
        let Value::Value(engine) = &config.engine else {
            config.engine_json = Value::Unknown;
            config.hardware_json = Value::Unknown;
            config.available = Value::Unknown;
            config.status = Value::Unknown;
            return Some(config);
        };
        let (facts, hardware) = observe_host(self.0.connections(), engine).await;
        let (Ok(facts_json), Ok(hardware_json)) = (
            serde_json::to_string(&facts),
            serde_json::to_string(&hardware),
        ) else {
            diags.root_error_short("Engine observation could not be encoded");
            return None;
        };
        // The engine's reachability; hardware reports its own status in hardware_json.
        let status = match facts.status {
            ObservationStatus::Available => "available",
            ObservationStatus::Unavailable => "unavailable",
            ObservationStatus::Unknown => "unknown",
        };
        config.engine_json = Value::Value(facts_json);
        config.hardware_json = Value::Value(hardware_json);
        config.available = Value::Value(facts.status == ObservationStatus::Available);
        config.status = Value::Value(status.into());
        Some(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNREACHABLE: &str = "unix:///does-not-exist/nemoclaw.sock";

    fn state(engine: Value<String>) -> HostEngineState {
        HostEngineState {
            engine,
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
    async fn unknown_engine_defers_every_output() {
        let source = HostEngineDataSource(Arc::new(ConfiguredBackend::default()));
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
        assert!(matches!(result.available, Value::Unknown));
        assert!(matches!(result.engine_json, Value::Unknown));
        assert!(matches!(result.hardware_json, Value::Unknown));
        assert!(diagnostics.errors.is_empty());
    }

    #[tokio::test]
    async fn unreachable_engine_completes_unknown_observations_without_provider_error() {
        let source = HostEngineDataSource(Arc::new(ConfiguredBackend::default()));
        let mut diagnostics = Diagnostics::default();
        let result = source
            .read(
                &mut diagnostics,
                state(Value::Value(UNREACHABLE.into())),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(matches!(result.available, Value::Value(false)));
        assert!(matches!(result.status, Value::Value(ref status) if status == "unknown"));
        assert_eq!(status(&result.engine_json), "unknown");
        assert_eq!(status(&result.hardware_json), "unknown");
        assert!(diagnostics.errors.is_empty());
    }

    #[tokio::test]
    async fn unknown_inputs_validate_without_connecting_and_invalid_values_do_not_leak() {
        let source = HostEngineDataSource(Arc::new(ConfiguredBackend::default()));
        let mut diagnostics = Diagnostics::default();
        assert!(
            source
                .validate(&mut diagnostics, state(Value::Unknown))
                .await
                .is_some()
        );
        assert!(
            source
                .validate(
                    &mut diagnostics,
                    state(Value::Value("PRIVATE_SENTINEL".into()))
                )
                .await
                .is_none()
        );
        assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
    }
}
