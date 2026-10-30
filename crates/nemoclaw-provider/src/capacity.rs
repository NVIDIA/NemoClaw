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

/// Data source for the capacity one runtime's services need on an engine.
pub(crate) struct CapacityDataSource(
    pub Arc<ConfiguredBackend>,
    pub crate::services::ServiceRuntime,
);
#[derive(Serialize, Deserialize)]
pub(crate) struct CapacityState {
    engine: Value<String>,
    contracts: Value<Vec<Value<String>>>,
    gpu: Value<String>,
    required_bytes: Value<u64>,
    observed_bytes: Value<u64>,
    compatible: Value<bool>,
}
fn requirements(
    config: &CapacityState,
    runtime: crate::services::ServiceRuntime,
) -> Result<(), nemoclaw_sdk::Error> {
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
            Value::Value(contract) => {
                runtime.check(contract)?;
                known.push(contract.clone());
            }
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
                    ("gpu", AttributeType::String, AttributeConstraint::Optional),
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
        if let Value::Value(gpu) = &config.gpu
            && let Err(error) = crate::services::validate_capacity_gpu(gpu)
        {
            diags.error(
                "Invalid service capacity GPU",
                error.to_string(),
                AttributePath::new("gpu"),
            );
            return None;
        }
        match requirements(&config, self.1) {
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
            requirements(&config, self.1)?;
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
            let gpu = match &config.gpu {
                Value::Value(gpu) => Some(gpu.as_str()),
                Value::Null => None,
                Value::Unknown => {
                    return Err(nemoclaw_sdk::Error::State(
                        "capacity requirements are not yet known",
                    ));
                }
            };
            crate::services::observe_service_capacity(self.0.connections(), engine, &contracts, gpu)
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
        let source = CapacityDataSource(
            Arc::new(ConfiguredBackend::default()),
            crate::services::ServiceRuntime::Vllm,
        );
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
                        gpu: Value::Null,
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

    /// Each runtime's capacity counts only that runtime's services; a combined
    /// check across runtimes has no provider.
    #[tokio::test]
    async fn capacity_rejects_another_runtimes_contract() {
        use crate::services::ServiceRuntime::{Ollama, Vllm};
        for (runtime, contract, expected) in [
            (
                Vllm,
                r#"{"kind":"ollama","PRIVATE_SENTINEL":1}"#,
                "an Ollama contract",
            ),
            (
                Ollama,
                r#"{"kind":"vllm","PRIVATE_SENTINEL":1}"#,
                "a vLLM contract",
            ),
        ] {
            let source = CapacityDataSource(Arc::new(ConfiguredBackend::default()), runtime);
            let mut diagnostics = Diagnostics::default();
            let state = CapacityState {
                engine: Value::Value("unix:///var/run/docker.sock".into()),
                contracts: Value::Value(vec![Value::Value(contract.into())]),
                gpu: Value::Null,
                required_bytes: Value::Null,
                observed_bytes: Value::Null,
                compatible: Value::Null,
            };
            assert!(source.validate(&mut diagnostics, state).await.is_none());
            let message = format!("{diagnostics:?}");
            assert!(message.contains(expected), "{message}");
            assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
        }
    }

    /// Records the GPU each observation names.
    struct Recorder(std::sync::Mutex<Vec<Option<String>>>);
    #[async_trait]
    impl crate::hardware::HostObserver for Recorder {
        async fn observe(
            &self,
            _: &crate::docker::Engine,
            gpu: Option<&str>,
        ) -> Result<crate::hardware::HostObservation, nemoclaw_sdk::Error> {
            self.0.lock().unwrap().push(gpu.map(Into::into));
            Ok(crate::hardware::HostObservation {
                engine_id: "engine".into(),
                capacity: crate::services::capacity::tests::capacity(),
            })
        }
    }

    #[tokio::test]
    async fn a_capacity_read_observes_only_the_gpu_it_names() {
        let fixture = crate::docker::fixture::Fixture::engine(|request| {
            assert_eq!(request.path, "/info");
            Some((
                200,
                serde_json::json!({"ID": "engine"}).to_string().into_bytes(),
            ))
        })
        .await;
        let recorder = Arc::new(Recorder(Default::default()));
        let connections = crate::docker::Connections::fixed([fixture
            .engine_for("ssh://operator@gpu-box")
            .with_host_observer(recorder.clone())])
        .unwrap();
        let source = CapacityDataSource(
            Arc::new(ConfiguredBackend::fixed(connections)),
            crate::services::ServiceRuntime::Vllm,
        );
        let contracts: Vec<_> = crate::services::capacity::tests::specs()
            .into_iter()
            .map(Value::Value)
            .collect();
        for gpu in [Value::Value("1".into()), Value::Null] {
            let mut diagnostics = Diagnostics::default();
            let state = CapacityState {
                engine: Value::Value("ssh://operator@gpu-box".into()),
                contracts: Value::Value(contracts.clone()),
                gpu,
                required_bytes: Value::Null,
                observed_bytes: Value::Null,
                compatible: Value::Null,
            };
            let read = source
                .read(&mut diagnostics, state, ValueEmpty::default())
                .await;
            assert!(read.is_some(), "{diagnostics:?}");
        }
        assert_eq!(*recorder.0.lock().unwrap(), [Some("1".into()), None]);
    }

    /// `gpu` names one GPU as `container.gpu` does; anything else fails before
    /// the host is read, at that attribute, without repeating the value.
    #[tokio::test]
    async fn a_capacity_gpu_is_one_uuid_or_index() {
        let source = CapacityDataSource(
            Arc::new(ConfiguredBackend::default()),
            crate::services::ServiceRuntime::Vllm,
        );
        for (gpu, valid) in [
            (Value::Unknown, true),
            (Value::Value("0".into()), true),
            (Value::Value("1".into()), true),
            (
                Value::Value("GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3".into()),
                true,
            ),
            (Value::Value("all".into()), false),
            (Value::Value("0,1".into()), false),
            (Value::Value("device=0".into()), false),
            (Value::Value("01".into()), false),
            (Value::Value("1000".into()), false),
            (
                Value::Value("GPU-79B44E99-D10D-A381-8CD6-5CCB073EAEA3".into()),
                false,
            ),
            (Value::Value("PRIVATE_SENTINEL".into()), false),
        ] {
            let mut diagnostics = Diagnostics::default();
            let state = CapacityState {
                engine: Value::Value("ssh://gpu-box".into()),
                contracts: Value::Unknown,
                gpu: gpu.clone(),
                required_bytes: Value::Null,
                observed_bytes: Value::Null,
                compatible: Value::Null,
            };
            let result = source.validate(&mut diagnostics, state).await;
            assert_eq!(result.is_some(), valid, "{gpu:?}");
            let message = format!("{diagnostics:?}");
            assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
            if !valid {
                assert!(message.contains("\"gpu\""), "{message}");
            }
        }
    }
}
