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
        for (name, value) in config.iter().filter(|(name, _)| *name != SPEC) {
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
        Some(Schema { version: 0, block })
    }

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: RuntimeState) -> Option<()> {
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
        match self.specification(&config) {
            Ok(Some(spec)) => {
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
        use nemoclaw_sdk::{compile, config::Document};
        for (kind, data, yaml) in [
            (
                "inference_service",
                "nemoclaw_vllm_runtime",
                include_str!("../../../examples/spark/vllm.yaml"),
            ),
            (
                "inference_service",
                "nemoclaw_vllm_runtime",
                include_str!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml"),
            ),
            (
                "ollama_service",
                "nemoclaw_ollama_runtime",
                include_str!("../../../examples/managed-ollama.yaml"),
            ),
        ] {
            let source = if kind == "ollama_service" {
                RuntimeDataSource::ollama().unwrap()
            } else {
                RuntimeDataSource::vllm().unwrap()
            };
            let document = Document::parse(yaml.as_bytes()).unwrap();
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
            assert_eq!(
                source.specification(&config).unwrap().unwrap(),
                spec.process.unwrap().configuration
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
}
