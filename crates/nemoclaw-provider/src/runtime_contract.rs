// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Computes a validated runtime contract (vLLM or Ollama) from typed
//! settings, the way a policy document data source computes a policy.

use async_trait::async_trait;
use nemoclaw_runtime::schema::PathSegment;
use nemoclaw_tofu::shape::{Dynamic, Fields, Shape, block, from_hcl, json, single_blocks};
use std::collections::BTreeMap;
use tf_provider::{
    AttributePath, DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Description, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) type RuntimeState = BTreeMap<String, Value<Dynamic>>;

const SPEC: &str = "spec";
const LAUNCH: &str = "launch";
const REQUIREMENTS: &str = "requirements";
const GPU_DEVICES: &str = "gpu_devices";

/// What any platform runs for a runtime specification, and what the runtime
/// needs from it: the launch and requirements Docker placement uses.
fn placement(spec: &str, gpu_count: u64) -> Option<(serde_json::Value, serde_json::Value)> {
    use nemoclaw_sdk::managed::{
        RUNTIME_DATA_PATH, RUNTIME_ENTRYPOINT, RUNTIME_SPEC_ENV, RUNTIME_ULIMITS,
        default_shared_memory_bytes,
    };
    let parsed = serde_json::from_str::<serde_json::Value>(spec).ok()?;
    let port = parsed["serving"]["port"].as_u64()?;
    // An authenticated server takes a platform's key from this variable.
    let key_env = if parsed["authentication"].is_null() {
        ""
    } else {
        nemoclaw_runtime::INFERENCE_KEY_ENV
    };
    let ulimits: serde_json::Map<String, serde_json::Value> = RUNTIME_ULIMITS
        .iter()
        .map(|(name, limit)| ((*name).to_owned(), serde_json::json!(limit)))
        .collect();
    Some((
        serde_json::json!({
            "entrypoint": [RUNTIME_ENTRYPOINT],
            "command": [],
            "environment": {RUNTIME_SPEC_ENV: spec},
            "port": port,
            "data_path": RUNTIME_DATA_PATH,
            "key_env": key_env,
        }),
        serde_json::json!({
            "gpu": true,
            "gpu_count": gpu_count,
            "shared_memory_bytes": default_shared_memory_bytes(),
            "ulimits": ulimits,
        }),
    ))
}

/// A JSON value as an OpenTofu dynamic value.
fn dynamic(value: serde_json::Value) -> Value<Dynamic> {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(value) => Value::Value(Dynamic::Bool(value)),
        serde_json::Value::Number(number) => Value::Value(match number.as_i64() {
            Some(integer) => Dynamic::Integer(integer),
            None => Dynamic::Float(number.as_f64().unwrap_or_default()),
        }),
        serde_json::Value::String(value) => Value::Value(Dynamic::String(value)),
        serde_json::Value::Array(values) => {
            Value::Value(Dynamic::List(values.into_iter().map(dynamic).collect()))
        }
        serde_json::Value::Object(values) => Value::Value(Dynamic::Map(
            values
                .into_iter()
                .map(|(key, value)| (key, dynamic(value)))
                .collect(),
        )),
    }
}

/// The number of GPUs the runtime needs: the length of `gpu_devices`, the
/// service's `container.gpuDevices`, or 1 without it, because the container
/// then gets every GPU and the runtime requires exactly one. `None` while the
/// list or an entry is unknown.
fn gpu_count(config: &RuntimeState) -> Result<Option<u64>, nemoclaw_sdk::Error> {
    use crate::services::{capacity::GPU_DEVICES_ENTRY, validate_capacity_gpu_devices};
    let devices = match config.get(GPU_DEVICES) {
        None | Some(Value::Null) => return Ok(Some(1)),
        Some(Value::Unknown) => return Ok(None),
        Some(Value::Value(Dynamic::List(devices))) => devices,
        Some(Value::Value(_)) => return Err(crate::Error::Conflict(GPU_DEVICES_ENTRY)),
    };
    let devices = devices
        .iter()
        .map(|device| match device {
            Value::Value(Dynamic::String(device)) => Ok(Some(device.as_str())),
            Value::Unknown => Ok(None),
            _ => Err(crate::Error::Conflict(GPU_DEVICES_ENTRY)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    validate_capacity_gpu_devices(&devices)?;
    Ok(devices
        .iter()
        .all(Option::is_some)
        .then_some(devices.len() as u64))
}

/// The OpenTofu types of `launch` and `requirements`.
fn placement_types() -> [(&'static str, AttributeType, &'static str); 2] {
    use AttributeType::{Bool, List, Map, Number, Object, String};
    [
        (
            LAUNCH,
            Object(std::collections::HashMap::from([
                ("entrypoint".into(), List(Box::new(String))),
                ("command".into(), List(Box::new(String))),
                ("environment".into(), Map(Box::new(String))),
                ("port".into(), Number),
                ("data_path".into(), String),
                ("key_env".into(), String),
            ])),
            "What any platform runs: entrypoint, command, environment (including the contract), the port the server listens on, the path for its data, and key_env, the variable an authenticated server reads a supplied API key from (empty without authentication). Place it with any container platform.",
        ),
        (
            REQUIREMENTS,
            Object(std::collections::HashMap::from([
                ("gpu".into(), Bool),
                ("gpu_count".into(), Number),
                ("shared_memory_bytes".into(), Number),
                ("ulimits".into(), Map(Box::new(Number))),
            ])),
            "What the runtime needs from its platform: a GPU and how many to give it (gpu_count: the length of gpu_devices, or 1 without it), shared memory (a recommended minimum), and process limits by name, where -1 is unlimited. Platforms that cannot set process limits leave them to the node.",
        ),
    ]
}

/// One runtime's contract: its settings schema and its encoding.
pub(crate) struct RuntimeDataSource {
    fields: Fields,
    /// The specification's `kind` tag.
    kind: &'static str,
    /// Apply defaults to settings and tag them as this runtime's specification.
    encode: fn(serde_json::Value) -> Option<nemoclaw_runtime::RuntimeSpec>,
}

impl RuntimeDataSource {
    pub(crate) fn vllm() -> Result<Self, nemoclaw_tofu::shape::Unmappable> {
        Ok(Self {
            fields: nemoclaw_sdk::services::installers::vllm::runtime_fields()?,
            kind: "vllm",
            encode: |settings| {
                let mut service: nemoclaw_runtime::vllm::Service =
                    serde_json::from_value(settings).ok()?;
                service.defaults();
                Some(nemoclaw_runtime::RuntimeSpec::Vllm(Box::new(service)))
            },
        })
    }
    pub(crate) fn ollama() -> Result<Self, nemoclaw_tofu::shape::Unmappable> {
        Ok(Self {
            fields: nemoclaw_sdk::services::installers::ollama::runtime_fields()?,
            kind: "ollama",
            encode: |settings| {
                let mut service: nemoclaw_runtime::ollama::ManagedOllama =
                    serde_json::from_value(settings).ok()?;
                service.defaults();
                Some(nemoclaw_runtime::RuntimeSpec::Ollama(Box::new(service)))
            },
        })
    }

    /// The runtime specification, or `None` while any setting is unknown.
    fn specification(
        &self,
        config: &RuntimeState,
    ) -> Result<Option<String>, (AttributePath, String)> {
        let mut settings = serde_json::Map::new();
        // `gpu_devices` is placement input, not a runtime setting.
        for (name, value) in config
            .iter()
            .filter(|(name, _)| *name != SPEC && *name != GPU_DEVICES)
        {
            let Some(value) = json(value) else {
                return Ok(None);
            };
            settings.insert(name.clone(), value);
        }
        let settings = single_blocks(
            &Shape::Object(self.fields.clone()),
            serde_json::Value::Object(settings),
        );
        let settings = from_hcl(&self.fields, &settings);
        let tagged = |mut value: serde_json::Value| {
            value["kind"] = serde_json::json!(self.kind);
            value
        };
        // Omitted or zero settings select their defaults, as in YAML.
        let spec = (self.encode)(settings.clone()).ok_or_else(|| {
            self.located(
                &tagged(settings),
                format!("settings do not match the {} runtime contract", self.kind),
            )
        })?;
        let normalized = serde_json::to_value(&spec).map_err(|_| {
            (
                AttributePath::root(),
                "cannot encode the runtime specification".to_owned(),
            )
        })?;
        nemoclaw_runtime::RuntimeSpec::decode(&normalized.to_string())
            .map_err(|error| self.located(&normalized, error.to_string()))?;
        // Encode the typed value, as the SDK does, so field order matches.
        serde_json::to_string(&spec).map(Some).map_err(|_| {
            (
                AttributePath::root(),
                "cannot encode the runtime specification".to_owned(),
            )
        })
    }

    /// Place a diagnostic at the first attribute the runtime schema rejects.
    fn located(&self, value: &serde_json::Value, error: String) -> (AttributePath, String) {
        let (path, location) = nemoclaw_runtime::schema::violation(value)
            .map(|segments| attribute_path(&self.fields, &segments))
            .unwrap_or_else(|| (AttributePath::root(), String::new()));
        if location.is_empty() {
            (path, error)
        } else {
            (path, format!("{location}: {error}"))
        }
    }
}

/// The OpenTofu attribute path, and its dotted spelling, for the declared
/// fields and indices of a violation. Undeclared keys end the path.
fn attribute_path(fields: &Fields, segments: &[PathSegment]) -> (AttributePath, String) {
    let mut path = AttributePath::root();
    let mut spelled = String::new();
    let mut shape = Shape::Object(fields.clone());
    for segment in segments {
        let next = match (segment, &shape) {
            (PathSegment::Field(json), Shape::Object(fields)) => fields
                .iter()
                .find(|(_, field)| field.json == *json)
                .map(|(name, field)| {
                    path.add_attribute(name.clone());
                    if matches!(field.shape, Shape::Object(_)) && !field.required {
                        // An optional block is a list of at most one block.
                        path.add_index(0);
                    }
                    if !spelled.is_empty() {
                        spelled.push('.');
                    }
                    spelled.push_str(name);
                    field.shape.clone()
                }),
            (PathSegment::Index(index), Shape::List(item)) => {
                path.add_index(*index as i64);
                spelled.push_str(&format!("[{index}]"));
                Some((**item).clone())
            }
            (PathSegment::Index(index), Shape::ObjectList(fields)) => {
                path.add_index(*index as i64);
                spelled.push_str(&format!("[{index}]"));
                Some(Shape::Object(fields.clone()))
            }
            _ => None,
        };
        match next {
            Some(next) => shape = next,
            None => break,
        }
    }
    (path, spelled)
}

#[async_trait]
impl DataSource for RuntimeDataSource {
    type State<'a> = RuntimeState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let mut block = block(
            &self.fields,
            "Computes a runtime contract from typed settings without contacting any host.",
        );
        block.attributes.insert(
            SPEC.into(),
            Attribute {
                attr_type: AttributeType::String,
                description: Description::plain(
                    "Validated runtime specification for the container's NEMOCLAW_RUNTIME_SPEC environment variable.",
                ),
                constraint: AttributeConstraint::Computed,
                ..Default::default()
            },
        );
        block.attributes.insert(
            GPU_DEVICES.into(),
            Attribute {
                attr_type: AttributeType::List(Box::new(AttributeType::String)),
                description: Description::plain(
                    "The GPUs the service's container gets, as its container.gpuDevices lists them: each a lowercase GPU UUID or an index from \"0\" to \"999\", and exactly one entry, because serving one model across several GPUs isn't implemented yet. It sets requirements.gpu_count and leaves spec unchanged. Omission means the container gets every GPU, and the runtime then requires exactly one.",
                ),
                constraint: AttributeConstraint::Optional,
                ..Default::default()
            },
        );
        for (name, attr_type, description) in placement_types() {
            block.attributes.insert(
                name.into(),
                Attribute {
                    attr_type,
                    description: Description::plain(description),
                    constraint: AttributeConstraint::Computed,
                    ..Default::default()
                },
            );
        }
        Some(Schema { version: 0, block })
    }

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: RuntimeState) -> Option<()> {
        if let Err(error) = gpu_count(&config) {
            diags.error(
                "Invalid runtime GPU devices",
                error.to_string(),
                AttributePath::new(GPU_DEVICES),
            );
            return None;
        }
        match self.specification(&config) {
            Ok(_) => Some(()),
            Err((path, detail)) => {
                diags.error("Invalid runtime settings", detail, path);
                None
            }
        }
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: RuntimeState,
        _: ValueEmpty,
    ) -> Option<RuntimeState> {
        let gpu_count = match gpu_count(&config) {
            Ok(Some(gpu_count)) => gpu_count,
            Ok(None) => {
                diags.root_error_short("Runtime settings are not yet known");
                return None;
            }
            Err(error) => {
                diags.error(
                    "Invalid runtime GPU devices",
                    error.to_string(),
                    AttributePath::new(GPU_DEVICES),
                );
                return None;
            }
        };
        match self.specification(&config) {
            Ok(Some(spec)) => {
                let Some((launch, requirements)) = placement(&spec, gpu_count) else {
                    diags.root_error_short("Runtime specification has no serving port");
                    return None;
                };
                config.insert(LAUNCH.into(), dynamic(launch));
                config.insert(REQUIREMENTS.into(), dynamic(requirements));
                config.insert(SPEC.into(), Value::Value(Dynamic::String(spec)));
                Some(config)
            }
            Ok(None) => {
                diags.root_error_short("Runtime settings are not yet known");
                None
            }
            Err((path, detail)) => {
                diags.error("Invalid runtime settings", detail, path);
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(json: serde_json::Value) -> Value<Dynamic> {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn omitted_blocks_and_attributes_do_not_reach_the_runtime_contract() {
        let source = RuntimeDataSource::vllm().unwrap();
        // OpenTofu sends optional blocks as lists of at most one block, and
        // every attribute of a present block, null when omitted.
        let config = RuntimeState::from([
            (
                "hardware".into(),
                value(serde_json::json!([{
                    "profile": "dgx-spark", "architecture": null, "min_compute_capability": null,
                    "min_driver_major": null, "min_gpu_memory_bytes": null
                }])),
            ),
            (
                "model".into(),
                value(serde_json::json!({
                    "repository": "Qwen/Qwen3-4B", "revision": "1cfa9a7208912126459214e8b04321603b3df60c"
                })),
            ),
            ("authentication".into(), Value::Null),
            ("recipe".into(), value(serde_json::json!([]))),
            ("serving".into(), value(serde_json::json!([]))),
            ("memory".into(), value(serde_json::json!([]))),
            (SPEC.into(), Value::Null),
        ]);
        let spec = source.specification(&config).unwrap().unwrap();
        let spec: serde_json::Value = serde_json::from_str(&spec).unwrap();
        assert_eq!(
            spec["hardware"],
            serde_json::json!({"profile": "dgx-spark"})
        );
        assert!(spec.get("recipe").is_none());
    }

    #[test]
    fn generated_settings_reproduce_the_compiled_runtime_contract() {
        use nemoclaw_sdk::{compile, config::Document, managed::Gpus};
        const UUID: &str = "GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3";
        for (kind, data, yaml, gpu) in [
            (
                "inference_service",
                "vllm_runtime",
                include_str!("../../../examples/spark/vllm.yaml"),
                None,
            ),
            (
                "inference_service",
                "vllm_runtime",
                include_str!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml"),
                None,
            ),
            (
                "inference_service",
                "vllm_runtime",
                include_str!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml"),
                Some("1"),
            ),
            (
                "ollama_service",
                "ollama_runtime",
                include_str!("../../../examples/managed-ollama.yaml"),
                None,
            ),
            (
                "ollama_service",
                "ollama_runtime",
                include_str!("../../../examples/managed-ollama.yaml"),
                Some(UUID),
            ),
        ] {
            let source = if kind == "ollama_service" {
                RuntimeDataSource::ollama().unwrap()
            } else {
                RuntimeDataSource::vllm().unwrap()
            };
            let mut document = Document::parse(yaml.as_bytes()).unwrap();
            if let Some(gpu) = gpu {
                let mut value = serde_json::to_value(&document).unwrap();
                for service in value["spec"]["services"]
                    .as_object_mut()
                    .unwrap()
                    .values_mut()
                    .filter(|service| matches!(service["kind"].as_str(), Some("vllm" | "ollama")))
                {
                    service["container"]["gpuDevices"] = serde_json::json!([gpu]);
                }
                document = Document::parse(value.to_string().as_bytes()).unwrap();
            }
            let generations = [
                "workspace",
                "provider",
                "sandbox",
                "managed_gateway",
                "inference_service",
                "ollama_service",
            ]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
            let graph = compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
            let target = compile::runtime_targets(&document, &generations)
                .unwrap()
                .into_iter()
                .find(|target| target.kind == kind)
                .unwrap();
            let spec: nemoclaw_sdk::managed::Spec =
                serde_json::from_str(&target.values["spec"]).unwrap();
            let settings = graph["data"][data]
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .to_string()
                // The graph escapes template sequences for OpenTofu.
                .replace("$${", "${")
                .replace("%%{", "%{");
            let config: RuntimeState = serde_json::from_str(&settings).unwrap();
            // The generated settings carry the service's GPU selection.
            assert_eq!(
                config.get(GPU_DEVICES).and_then(json),
                gpu.map(|gpu| serde_json::json!([gpu])),
                "{kind}"
            );
            let computed = source.specification(&config).unwrap().unwrap();
            let process = spec.process.clone().unwrap();
            assert_eq!(computed, process.configuration);
            // The platform-neutral launch is what Docker placement runs.
            let (launch, requirements) =
                placement(&computed, gpu_count(&config).unwrap().unwrap()).unwrap();
            let docker =
                serde_json::to_value(spec.container(&process.mount_target).unwrap()).unwrap();
            assert_eq!(launch["entrypoint"], docker["Entrypoint"], "{kind}");
            assert_eq!(launch["command"], docker["Cmd"], "{kind}");
            let environment: Vec<String> = launch["environment"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, value)| format!("{name}={}", value.as_str().unwrap()))
                .collect();
            assert_eq!(serde_json::json!(environment), docker["Env"], "{kind}");
            assert_eq!(launch["port"], process.port, "{kind}");
            assert_eq!(launch["data_path"], process.mount_target, "{kind}");
            assert_eq!(requirements["gpu"], process.gpus != Gpus::None, "{kind}");
            // Without a selection the container gets every GPU, and the
            // runtime requires exactly one; a selection counts its devices.
            let gpu_count = match &process.gpus {
                Gpus::None => 0,
                Gpus::All => 1,
                Gpus::Devices(devices) => devices.len(),
            };
            assert_eq!(
                matches!(process.gpus, Gpus::Devices(_)),
                gpu.is_some(),
                "{kind}"
            );
            assert_eq!(requirements["gpu_count"], gpu_count, "{kind} {gpu:?}");
            assert_eq!(
                requirements["shared_memory_bytes"], process.shared_memory_bytes,
                "{kind}"
            );
            let ulimits: serde_json::Map<String, serde_json::Value> =
                docker["HostConfig"]["Ulimits"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|limit| {
                        (
                            limit["Name"].as_str().unwrap().to_owned(),
                            limit["Hard"].clone(),
                        )
                    })
                    .collect();
            assert_eq!(
                requirements["ulimits"],
                serde_json::Value::Object(ulimits),
                "{kind}"
            );
        }
    }

    #[test]
    fn rejected_settings_name_their_block_attribute() {
        let source = RuntimeDataSource::vllm().unwrap();
        let config = RuntimeState::from([
            (
                "hardware".into(),
                value(serde_json::json!([{"profile": "dgx-spark"}])),
            ),
            (
                "model".into(),
                value(serde_json::json!({
                    "repository": "Qwen/Qwen3-4B", "revision": "1cfa9a7208912126459214e8b04321603b3df60c"
                })),
            ),
            ("serving".into(), value(serde_json::json!([{"port": 80}]))),
        ]);
        let (path, detail) = source.specification(&config).unwrap_err();
        assert_eq!(
            path,
            AttributePath::new("serving").index(0).attribute("port")
        );
        assert!(detail.starts_with("serving.port: "), "{detail}");
    }

    #[test]
    fn the_launch_names_the_key_variable_only_for_authenticated_servers() {
        let authenticated = r#"{"serving":{"port":8000},"authentication":"bearer"}"#;
        let (launch, _) = placement(authenticated, 1).unwrap();
        assert_eq!(launch["key_env"], nemoclaw_runtime::INFERENCE_KEY_ENV);
        let open = r#"{"serving":{"port":8000}}"#;
        let (launch, _) = placement(open, 1).unwrap();
        assert_eq!(launch["key_env"], "");
    }

    /// `gpu_devices` lists GPUs as `container.gpuDevices` does, exactly one for
    /// now; anything else fails at that attribute without repeating the value.
    #[tokio::test]
    async fn runtime_gpu_devices_list_one_uuid_or_index() {
        let source = RuntimeDataSource::vllm().unwrap();
        let entry = "each gpu_devices entry must be a lowercase GPU UUID or an index";
        let one = "serving one model across several GPUs isn't implemented yet";
        for (gpu_devices, error) in [
            (Value::Unknown, None),
            (value(serde_json::json!(["1"])), None),
            (
                value(serde_json::json!([
                    "GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3"
                ])),
                None,
            ),
            (value(serde_json::json!(["0", "1"])), Some(one)),
            (value(serde_json::json!([])), Some(one)),
            (
                value(serde_json::json!(["0", "0"])),
                Some("gpu_devices must not repeat a GPU"),
            ),
            (value(serde_json::json!([null])), Some(entry)),
            (value(serde_json::json!(["PRIVATE_SENTINEL"])), Some(entry)),
        ] {
            let mut diagnostics = Diagnostics::default();
            let config = RuntimeState::from([
                (
                    "hardware".into(),
                    value(serde_json::json!([{"profile": "dgx-spark"}])),
                ),
                (
                    "model".into(),
                    value(serde_json::json!({
                        "repository": "Qwen/Qwen3-4B", "revision": "1cfa9a7208912126459214e8b04321603b3df60c"
                    })),
                ),
                (GPU_DEVICES.into(), gpu_devices.clone()),
            ]);
            let result = source.validate(&mut diagnostics, config).await;
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
