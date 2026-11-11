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
    gpu_devices: Value<Vec<Value<String>>>,
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
/// Check the GPUs `gpu_devices` lists, deferring entries not yet known.
fn gpu_devices(devices: &[Value<String>]) -> Result<(), nemoclaw_sdk::Error> {
    use crate::services::{capacity::GPU_DEVICES_ENTRY, validate_capacity_gpu_devices};
    let devices = devices
        .iter()
        .map(|device| match device {
            Value::Value(device) => Ok(Some(device.as_str())),
            Value::Unknown => Ok(None),
            Value::Null => Err(crate::Error::Conflict(GPU_DEVICES_ENTRY)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_capacity_gpu_devices(&devices)
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
                        "gpu_devices",
                        AttributeType::List(Box::new(AttributeType::String)),
                        AttributeConstraint::Optional,
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
        if let Value::Value(devices) = &config.gpu_devices
            && let Err(error) = gpu_devices(devices)
        {
            diags.error(
                "Invalid service capacity GPU devices",
                error.to_string(),
                AttributePath::new("gpu_devices"),
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
            let gpu_devices = match &config.gpu_devices {
                Value::Value(devices) => {
                    gpu_devices(devices)?;
                    Some(
                        devices
                            .iter()
                            .map(|device| match device {
                                Value::Value(device) => Ok(device.clone()),
                                _ => Err(nemoclaw_sdk::Error::State(
                                    "capacity requirements are not yet known",
                                )),
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    )
                }
                Value::Null => None,
                Value::Unknown => {
                    return Err(nemoclaw_sdk::Error::State(
                        "capacity requirements are not yet known",
                    ));
                }
            };
            crate::services::observe_service_capacity(
                self.0.connections(),
                engine,
                &contracts,
                gpu_devices.as_deref(),
            )
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
                        gpu_devices: Value::Null,
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
                gpu_devices: Value::Null,
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
            // Report the listed GPU, as `nvidia-smi --id` does.
            let mut capacity = crate::services::capacity::tests::capacity();
            if let Some(index) = gpu.and_then(|gpu| gpu.parse().ok()) {
                capacity.gpus[0].index = index;
            }
            Ok(crate::hardware::HostObservation {
                engine_id: "engine".into(),
                capacity,
            })
        }
    }

    #[tokio::test]
    async fn a_capacity_read_observes_only_the_gpu_it_lists() {
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
        for gpu_devices in [Value::Value(vec![Value::Value("1".into())]), Value::Null] {
            let mut diagnostics = Diagnostics::default();
            let state = CapacityState {
                engine: Value::Value("ssh://operator@gpu-box".into()),
                contracts: Value::Value(contracts.clone()),
                gpu_devices,
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

    /// `gpu_devices` lists GPUs as `container.gpuDevices` does, exactly one for
    /// now; anything else fails before the host is read, at that attribute,
    /// without repeating the value.
    #[tokio::test]
    async fn capacity_gpu_devices_list_one_uuid_or_index() {
        let source = CapacityDataSource(
            Arc::new(ConfiguredBackend::default()),
            crate::services::ServiceRuntime::Vllm,
        );
        let list = |devices: &[&str]| {
            Value::Value(
                devices
                    .iter()
                    .map(|device| Value::Value((*device).into()))
                    .collect::<Vec<_>>(),
            )
        };
        let entry = "each gpu_devices entry must be a lowercase GPU UUID or an index";
        let one = "serving one model across several GPUs isn't implemented yet";
        for (gpu_devices, error) in [
            (Value::Unknown, None),
            (Value::Value(vec![Value::Unknown]), None),
            (list(&["0"]), None),
            (list(&["999"]), None),
            (list(&["GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3"]), None),
            (list(&[]), Some(one)),
            (list(&["0", "1"]), Some(one)),
            (
                Value::Value(vec![Value::Value("0".into()), Value::Unknown]),
                Some(one),
            ),
            (list(&["0", "0"]), Some("gpu_devices must not repeat a GPU")),
            (Value::Value(vec![Value::Null]), Some(entry)),
            (list(&["all"]), Some(entry)),
            (list(&["0,1"]), Some(entry)),
            (list(&["device=0"]), Some(entry)),
            (list(&["01"]), Some(entry)),
            (list(&["1000"]), Some(entry)),
            (
                list(&["GPU-79B44E99-D10D-A381-8CD6-5CCB073EAEA3"]),
                Some(entry),
            ),
            (list(&["PRIVATE_SENTINEL"]), Some(entry)),
        ] {
            let mut diagnostics = Diagnostics::default();
            let state = CapacityState {
                engine: Value::Value("ssh://gpu-box".into()),
                contracts: Value::Unknown,
                gpu_devices: gpu_devices.clone(),
                required_bytes: Value::Null,
                observed_bytes: Value::Null,
                compatible: Value::Null,
            };
            let result = source.validate(&mut diagnostics, state).await;
            assert_eq!(result.is_none(), error.is_some(), "{gpu_devices:?}");
            let message = format!("{diagnostics:?}");
            assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
            if let Some(error) = error {
                assert!(message.contains(error), "{message}");
                assert!(message.contains("\"gpu_devices\""), "{message}");
            }
        }
    }
}
