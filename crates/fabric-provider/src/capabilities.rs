// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! What an image says about its Fabric catalog, and whether it suits a sandbox.

use async_trait::async_trait;
use nemoclaw_backend::{EnvironmentSecrets, ObservationStatus};
use nemoclaw_docker::Engines;
use nemoclaw_fabric::{FabricRequirements, capabilities::Support, judge_image, observe_fabric};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// Data source for an image's Fabric catalog and its compatibility with a
/// sandbox. It reads through the engine named on each read.
pub struct FabricCapabilitiesDataSource(pub Arc<dyn Engines>);

impl Default for FabricCapabilitiesDataSource {
    fn default() -> Self {
        Self(Arc::new(nemoclaw_docker::Direct))
    }
}

/// Inputs and outputs of `fabric_capabilities`. OpenTofu requires every
/// declared attribute, including absent optional values.
#[derive(Default, Serialize, Deserialize)]
pub struct FabricCapabilitiesState {
    engine: Value<String>,
    image: Value<String>,
    metadata_env: Value<String>,
    config_json: Value<String>,
    filesystem_read: Value<Vec<Value<String>>>,
    architecture: Value<String>,
    operating_system: Value<String>,
    compatibility_status: Value<String>,
    runtime_json: Value<String>,
    binaries_json: Value<String>,
    observation_json: Value<String>,
    available: Value<bool>,
    status: Value<String>,
}

fn known(value: &Value<String>) -> Option<&str> {
    match value {
        Value::Value(value) => Some(value.as_str()),
        _ => None,
    }
}

impl FabricCapabilitiesState {
    /// Mark every output unknown, for inputs not yet known at plan time.
    fn defer(mut self) -> Self {
        self.observation_json = Value::Unknown;
        self.available = Value::Unknown;
        self.status = Value::Unknown;
        self.compatibility_status = Value::Unknown;
        self.runtime_json = Value::Unknown;
        self.binaries_json = Value::Unknown;
        self
    }
}

/// The Fabric requirements the inputs describe: none when no configuration
/// is given, and an error when the configuration names no adapter.
fn requirements(config: &FabricCapabilitiesState) -> Result<Option<FabricRequirements>, ()> {
    let Value::Value(json) = &config.config_json else {
        return Ok(None);
    };
    let configuration: serde_json::Value = serde_json::from_str(json).map_err(|_| ())?;
    if !configuration
        .pointer("/harness/adapter_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| !id.is_empty())
    {
        return Err(());
    }
    let filesystem_read = match &config.filesystem_read {
        Value::Value(paths) => Some(
            paths
                .iter()
                .map(|path| match path {
                    Value::Value(path) => Ok(path.clone()),
                    _ => Err(()),
                })
                .collect::<Result<_, _>>()?,
        ),
        _ => None,
    };
    Ok(Some(FabricRequirements {
        configuration,
        filesystem_read,
    }))
}

fn valid(config: &FabricCapabilitiesState) -> bool {
    // An empty engine selects verified image metadata instead of an engine read.
    let engine_valid = match &config.engine {
        Value::Unknown => true,
        Value::Value(engine) => {
            engine.is_empty() || nemoclaw_docker::validate_engine_endpoint(engine).is_ok()
        }
        Value::Null => false,
    };
    let image_valid = matches!(&config.image, Value::Unknown)
        || matches!(&config.image, Value::Value(image) if !image.is_empty());
    // Unknown values are checked again when the read runs.
    let requirements_valid = matches!(&config.config_json, Value::Unknown)
        || matches!(&config.filesystem_read, Value::Value(paths) if paths.iter().any(|p| matches!(p, Value::Unknown)))
        || requirements(config).is_ok();
    let metadata_valid = match &config.metadata_env {
        Value::Null | Value::Unknown => true,
        Value::Value(name) => {
            (matches!(&config.engine, Value::Unknown)
                || matches!(&config.engine, Value::Value(engine) if engine.is_empty()))
                && regex::Regex::new(r"^[A-Z_][A-Z0-9_]*$")
                    .expect("constant environment name pattern")
                    .is_match(name)
        }
    };
    engine_valid && image_valid && requirements_valid && metadata_valid
}

#[async_trait]
impl DataSource for FabricCapabilitiesDataSource {
    type State<'a> = FabricCapabilitiesState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("engine", String, Required),
                    ("image", String, Required),
                    ("metadata_env", String, Optional),
                    ("config_json", String, Optional),
                    (
                        "filesystem_read",
                        AttributeType::List(Box::new(String)),
                        Optional,
                    ),
                    ("architecture", String, Optional),
                    ("operating_system", String, Optional),
                    ("observation_json", String, Computed),
                    ("available", Bool, Computed),
                    ("status", String, Computed),
                    ("compatibility_status", String, Computed),
                    ("runtime_json", String, Computed),
                    ("binaries_json", String, Computed),
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
        config: FabricCapabilitiesState,
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
        mut config: FabricCapabilitiesState,
        _: ValueEmpty,
    ) -> Option<FabricCapabilitiesState> {
        if !valid(&config) {
            diags.root_error_short("Invalid discovery target or selection");
            return None;
        }
        let (Value::Value(engine), Value::Value(image)) = (&config.engine, &config.image) else {
            return Some(config.defer());
        };
        if [
            &config.metadata_env,
            &config.config_json,
            &config.architecture,
            &config.operating_system,
        ]
        .iter()
        .any(|value| matches!(value, Value::Unknown))
            || matches!(&config.filesystem_read, Value::Unknown)
            || matches!(&config.filesystem_read, Value::Value(paths) if paths.iter().any(|p| matches!(p, Value::Unknown)))
        {
            return Some(config.defer());
        }
        let (engine, image) = (engine.clone(), image.clone());
        config.runtime_json = Value::Value(String::new());
        config.binaries_json = Value::Value("[]".into());
        let mut observation = if let Value::Value(name) = &config.metadata_env {
            nemoclaw_fabric::image_metadata::observe(&EnvironmentSecrets, name, &image)
        } else {
            observe_fabric(self.0.as_ref(), &engine, &image).await
        };
        if let Some(requirements) = requirements(&config).ok()? {
            if let Some(runtime) = observation
                .catalog
                .as_ref()
                .and_then(|catalog| catalog.runtime.as_ref())
            {
                let adapter_id = requirements.configuration["harness"]["adapter_id"]
                    .as_str()
                    .unwrap_or("");
                if runtime.binaries.contains_key(adapter_id) {
                    let binding = nemoclaw_openshell::runtime::RuntimeBinding {
                        runtime: runtime.clone(),
                        adapter_id: adapter_id.into(),
                    };
                    config.runtime_json = Value::Value(serde_json::to_string(&binding).ok()?);
                    config.binaries_json =
                        Value::Value(serde_json::to_string(binding.binaries()).ok()?);
                }
            }
            judge_image(
                &mut observation,
                &image,
                &requirements,
                known(&config.architecture),
                known(&config.operating_system),
            );
        }
        config.compatibility_status = Value::Value(
            match observation
                .compatibility
                .as_ref()
                .map(|report| report.status)
            {
                Some(Support::Supported) => "supported",
                Some(Support::Unsupported) => "unsupported",
                Some(Support::Unknown) | None => "unknown",
            }
            .into(),
        );
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

    fn fabric_config() -> FabricCapabilitiesState {
        FabricCapabilitiesState {
            engine: Value::Value("unix:///does-not-exist/nemoclaw.sock".into()),
            image: Value::Value("image:fixture".into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn missing_cluster_metadata_is_rejected_before_discovery() {
        let source = FabricCapabilitiesDataSource::default();
        let missing_metadata = || {
            let mut config = fabric_config();
            config.engine = Value::Value(String::new());
            config.image = Value::Value(format!("registry/agent@sha256:{}", "a".repeat(64)));
            config.metadata_env = Value::Value(String::new());
            config
        };
        let mut validation = Diagnostics::default();
        assert!(
            source
                .validate(&mut validation, missing_metadata())
                .await
                .is_none()
        );
        assert!(!validation.errors.is_empty());
        let mut read = Diagnostics::default();
        assert!(
            source
                .read(&mut read, missing_metadata(), ValueEmpty::default())
                .await
                .is_none()
        );
        assert!(!read.errors.is_empty());
        assert!(!format!("{read:?}").contains("/does-not-exist"));
    }

    #[tokio::test]
    async fn metadata_discovery_never_falls_back_to_a_container_engine() {
        let source = FabricCapabilitiesDataSource::default();
        let mut config = fabric_config();
        config.image = Value::Value(format!("registry/agent@sha256:{}", "a".repeat(64)));
        config.metadata_env = Value::Value("NEMOCLAW_TEST_UNSET_METADATA_77A856B9".into());
        assert!(
            !valid(&config),
            "an engine and metadata reference are mutually exclusive"
        );
        config.engine = Value::Value(String::new());
        let mut diagnostics = Diagnostics::default();
        let output = source
            .read(&mut diagnostics, config, ValueEmpty::default())
            .await
            .unwrap();
        assert!(diagnostics.errors.is_empty());
        assert_eq!(known(&output.runtime_json), Some(""));
        let observation: serde_json::Value =
            serde_json::from_str(known(&output.observation_json).unwrap()).unwrap();
        assert_eq!(observation["source"], "verified_oci_metadata");
        assert_eq!(observation["status"], "unknown");
        assert!(!observation.to_string().contains("/does-not-exist"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn selected_image_checks_fabric_plan_platform_and_missing_metadata_without_starting_containers()
     {
        use nemoclaw_fabric::catalog::{BridgeCapabilities, FabricCatalog, IMAGE_CATALOG_LABEL};
        let mut catalog = FabricCatalog::bundled();
        catalog.bridge = Some(BridgeCapabilities {
            interface_version: 1,
            operations: [
                "validate",
                "prepare",
                "configure",
                "check",
                "invoke",
                "serve",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            health_checks: Vec::new(),
        });
        catalog
            .adapters
            .retain(|adapter| adapter.adapter_id() == "nvidia.fabric.langchain.deepagents");
        let mut runtime: serde_json::Value =
            serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
        runtime["command"] = serde_json::json!(["/srv/python3.99", "-I", "/srv/bridge.py"]);
        runtime["binaries"] = serde_json::json!({"nvidia.fabric.langchain.deepagents":["/srv/python3.99","/srv/bun"]});
        catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
        let label = serde_json::to_string(&catalog).unwrap();
        let digest = format!("registry/agent@sha256:{}", "a".repeat(64));
        let served_digest = digest.clone();
        let fixture = crate::fixture::Fixture::start(move |request| {
            assert_eq!(request.method, "GET");
            assert!(request.path.starts_with("/images/"));
            assert!(request.body.is_empty());
            let mut image = serde_json::json!({"Id":"sha256:config", "Architecture":"arm64", "Os":"linux", "RepoDigests":[served_digest], "Config":{"Labels":{IMAGE_CATALOG_LABEL:label}}});
            if request.path.contains("missing") { image["Config"]["Labels"] = serde_json::json!({}); }
            Some((200, serde_json::to_vec(&image).unwrap()))
        }).await;
        let source = FabricCapabilitiesDataSource::default();
        for (settings, architecture, image, expected) in [
            (
                serde_json::json!({}),
                "aarch64",
                digest.as_str(),
                "supported",
            ),
            (
                serde_json::json!({"unknown_setting":true}),
                "aarch64",
                digest.as_str(),
                "unsupported",
            ),
            (
                serde_json::json!({}),
                "amd64",
                digest.as_str(),
                "unsupported",
            ),
            (serde_json::json!({}), "aarch64", "missing:image", "unknown"),
        ] {
            let mut config = fabric_config();
            config.engine = Value::Value(fixture.endpoint.clone());
            config.image = Value::Value(image.into());
            config.config_json =
                Value::Value(serde_json::json!({"schema_version":"fabric.agent/v1alpha1","metadata":{"name":"main"},"harness":{"adapter_id":"nvidia.fabric.langchain.deepagents","settings":settings},"runtime":{},"models":{"default":{"provider":"openai","model":"fixture-model","base_url":"http://localhost/v1","api_key_env":"MODEL_KEY"}}}).to_string());
            config.architecture = Value::Value(architecture.into());
            config.operating_system = Value::Value("linux".into());
            let mut diagnostics = Diagnostics::default();
            let output = source
                .read(&mut diagnostics, config, ValueEmpty::default())
                .await
                .unwrap();
            assert!(diagnostics.errors.is_empty());
            assert_eq!(known(&output.compatibility_status), Some(expected));
            let observation: serde_json::Value =
                serde_json::from_str(known(&output.observation_json).unwrap()).unwrap();
            assert_eq!(observation["compatibility"]["status"], expected);
            if image == "missing:image" {
                assert_eq!(known(&output.runtime_json), Some(""));
                assert_eq!(known(&output.binaries_json), Some("[]"));
            } else {
                let retained = nemoclaw_openshell::runtime::RuntimeBinding::from_json(
                    known(&output.runtime_json).unwrap(),
                )
                .unwrap();
                assert_eq!(
                    retained.command("status", &[]),
                    ["/srv/python3.99", "-I", "/srv/bridge.py", "status"]
                );
                assert_eq!(
                    serde_json::from_str::<Vec<String>>(known(&output.binaries_json).unwrap())
                        .unwrap(),
                    ["/srv/python3.99", "/srv/bun"]
                );
            }
        }
    }
    #[test]
    fn serialized_state_matches_its_schema_even_for_absent_optional_inputs() {
        let serialized = serde_json::to_value(fabric_config()).unwrap();
        let schema = FabricCapabilitiesDataSource::default()
            .schema(&mut Diagnostics::default())
            .unwrap();
        assert_eq!(
            serialized.as_object().unwrap().len(),
            schema.block.attributes.len()
        );
        for field in schema.block.attributes.keys() {
            assert!(
                serialized.get(field).is_some(),
                "schema field omitted: {field}"
            );
        }
        assert!(serialized["config_json"].is_null());
        assert!(serialized["filesystem_read"].is_null());
    }

    #[test]
    fn requirements_are_the_configuration_and_the_policy_reads_as_separate_inputs() {
        let schema = FabricCapabilitiesDataSource::default()
            .schema(&mut Diagnostics::default())
            .unwrap();
        let attribute = |name: &str| {
            schema
                .block
                .attributes
                .get(name)
                .map(|a| (format!("{:?}", a.attr_type), format!("{:?}", a.constraint)))
        };
        assert!(!schema.block.attributes.contains_key("requirements_json"));
        assert_eq!(
            attribute("config_json"),
            Some(("String".into(), "Optional".into()))
        );
        assert_eq!(
            attribute("filesystem_read"),
            Some(("List(String)".into(), "Optional".into()))
        );

        let mut config = fabric_config();
        config.config_json = Value::Value(r#"{"harness":{"adapter_id":"a"}}"#.into());
        config.filesystem_read = Value::Value(vec![Value::Value("/srv".into())]);
        let required = requirements(&config).unwrap().unwrap();
        assert_eq!(required.configuration["harness"]["adapter_id"], "a");
        assert_eq!(required.filesystem_read, Some(vec!["/srv".into()]));

        config.filesystem_read = Value::Null;
        assert_eq!(
            requirements(&config).unwrap().unwrap().filesystem_read,
            None
        );
        config.config_json = Value::Null;
        assert!(requirements(&config).unwrap().is_none());
        config.config_json = Value::Value(r#"{"harness":{}}"#.into());
        assert!(requirements(&config).is_err(), "an adapter_id is required");
    }
}
