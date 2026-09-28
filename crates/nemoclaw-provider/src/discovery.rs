// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_sdk::{
    discovery::{DiscoveryRequest, ObservationStatus, observe_engine, observe_fabric},
    docker::Engine,
    fabric_capabilities::{FabricRequirements, Support, assess_image},
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
#[derive(Deserialize)]
pub(crate) struct DiscoveryState {
    #[serde(skip)]
    fabric: bool,
    engine: Value<String>,
    #[serde(default)]
    compute_driver: Value<String>,
    #[serde(default)]
    image: Value<String>,
    #[serde(default)]
    requirements_json: Value<String>,
    #[serde(default)]
    architecture: Value<String>,
    #[serde(default)]
    operating_system: Value<String>,
    #[serde(default)]
    compatibility_status: Value<String>,
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

// OpenTofu requires every declared attribute, including absent optional values.
// The engine and Fabric sources share inputs but expose different state schemas.
impl Serialize for DiscoveryState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut state = serializer.serialize_map(Some(if self.fabric { 9 } else { 5 }))?;
        state.serialize_entry("engine", &self.engine)?;
        if self.fabric {
            state.serialize_entry("image", &self.image)?;
            state.serialize_entry("requirements_json", &self.requirements_json)?;
            state.serialize_entry("architecture", &self.architecture)?;
            state.serialize_entry("operating_system", &self.operating_system)?;
            state.serialize_entry("compatibility_status", &self.compatibility_status)?;
        } else {
            state.serialize_entry("compute_driver", &self.compute_driver)?;
        }
        state.serialize_entry("observation_json", &self.observation_json)?;
        state.serialize_entry("available", &self.available)?;
        state.serialize_entry("status", &self.status)?;
        state.end()
    }
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
        let requirements_valid = match &config.requirements_json {
            Value::Value(json) if self.fabric => serde_json::from_str::<FabricRequirements>(json)
                .is_ok_and(|request| {
                    request
                        .configuration
                        .pointer("/harness/adapter_id")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                }),
            Value::Value(_) => false,
            _ => true,
        };
        engine_valid && selection_valid && requirements_valid
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
                .chain(
                    self.fabric
                        .then_some([
                            (
                                "requirements_json",
                                AttributeType::String,
                                AttributeConstraint::Optional,
                            ),
                            (
                                "architecture",
                                AttributeType::String,
                                AttributeConstraint::Optional,
                            ),
                            (
                                "operating_system",
                                AttributeType::String,
                                AttributeConstraint::Optional,
                            ),
                            (
                                "compatibility_status",
                                AttributeType::String,
                                AttributeConstraint::Computed,
                            ),
                        ])
                        .into_iter()
                        .flatten(),
                )
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
        config.fabric = self.fabric;
        if !self.valid(&config) {
            diags.root_error_short("Invalid discovery target or selection");
            return None;
        }
        let Value::Value(engine) = &config.engine else {
            config.observation_json = Value::Unknown;
            config.available = Value::Unknown;
            config.status = Value::Unknown;
            if self.fabric {
                config.compatibility_status = Value::Unknown;
            }
            return Some(config);
        };
        let (status, json) = if self.fabric {
            let Value::Value(image) = &config.image else {
                config.observation_json = Value::Unknown;
                config.available = Value::Unknown;
                config.status = Value::Unknown;
                config.compatibility_status = Value::Unknown;
                return Some(config);
            };
            if [
                &config.requirements_json,
                &config.architecture,
                &config.operating_system,
            ]
            .iter()
            .any(|value| matches!(value, Value::Unknown))
            {
                config.observation_json = Value::Unknown;
                config.available = Value::Unknown;
                config.status = Value::Unknown;
                config.compatibility_status = Value::Unknown;
                return Some(config);
            }
            let mut observation = observe_fabric(self.backend.connections(), engine, image).await;
            if let Value::Value(json) = &config.requirements_json {
                let requirements: FabricRequirements = serde_json::from_str(json).ok()?;
                observation.compatibility = Some(assess_image(
                    observation.catalog.as_ref(),
                    &requirements,
                    &observation.image,
                    image,
                    known(&config.architecture),
                    known(&config.operating_system),
                ));
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
            (observation.status, serde_json::to_string(&observation))
        } else {
            let Value::Value(driver) = &config.compute_driver else {
                config.observation_json = Value::Unknown;
                config.available = Value::Unknown;
                config.status = Value::Unknown;
                config.compatibility_status = Value::Unknown;
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

#[cfg(all(test, unix))]
#[path = "../../test-support/docker.rs"]
mod transport;

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_config() -> DiscoveryState {
        DiscoveryState {
            fabric: false,
            engine: Value::Value("unix:///does-not-exist/nemoclaw.sock".into()),
            compute_driver: Value::Value("docker".into()),
            image: Value::Null,
            requirements_json: Value::Null,
            architecture: Value::Null,
            operating_system: Value::Null,
            compatibility_status: Value::Null,
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
    #[test]
    fn fabric_requirements_and_platform_inputs_do_not_leak_into_engine_schema() {
        let mut diagnostics = Diagnostics::default();
        let fabric = DiscoveryDataSource {
            backend: Arc::new(ConfiguredBackend::default()),
            fabric: true,
        };
        let engine = DiscoveryDataSource {
            backend: Arc::new(ConfiguredBackend::default()),
            fabric: false,
        };
        let fabric = fabric.schema(&mut diagnostics).unwrap();
        let engine = engine.schema(&mut diagnostics).unwrap();
        for field in [
            "requirements_json",
            "architecture",
            "operating_system",
            "compatibility_status",
        ] {
            assert!(
                fabric.block.attributes.contains_key(field),
                "missing Fabric field {field}"
            );
            assert!(
                !engine.block.attributes.contains_key(field),
                "Fabric field leaked into engine schema"
            );
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn selected_image_checks_fabric_plan_platform_and_missing_metadata_without_starting_containers()
     {
        use nemoclaw_sdk::fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
        let mut catalog = FabricCatalog::bundled();
        catalog
            .adapters
            .retain(|adapter| adapter.adapter_id() == "nvidia.fabric.langchain.deepagents");
        let label = serde_json::to_string(&catalog).unwrap();
        let digest = format!("registry/agent@sha256:{}", "a".repeat(64));
        let served_digest = digest.clone();
        let fixture = super::transport::Fixture::start(move |request| {
            assert_eq!(request.method, "GET");
            assert!(request.path.starts_with("/images/"));
            assert!(request.body.is_empty());
            let mut image = serde_json::json!({"Id":"sha256:config", "Architecture":"arm64", "Os":"linux", "RepoDigests":[served_digest], "Config":{"Labels":{IMAGE_CATALOG_LABEL:label}}});
            if request.path.contains("missing") { image["Config"]["Labels"] = serde_json::json!({}); }
            Some((200, serde_json::to_vec(&image).unwrap()))
        }).await;
        let source = DiscoveryDataSource {
            backend: Arc::new(ConfiguredBackend::default()),
            fabric: true,
        };
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
            let mut config = engine_config();
            config.engine = Value::Value(fixture.endpoint.clone());
            config.compute_driver = Value::Null;
            config.image = Value::Value(image.into());
            config.requirements_json =
                Value::Value(serde_json::json!({"configuration":{"schema_version":"fabric.agent/v1alpha1","metadata":{"name":"main"},"harness":{"adapter_id":"nvidia.fabric.langchain.deepagents","settings":settings},"runtime":{},"models":{"default":{"provider":"openai","model":"fixture-model","base_url":"http://localhost/v1","api_key_env":"MODEL_KEY"}}}}).to_string());
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
        }
    }
    #[test]
    fn serialized_discovery_state_matches_its_schema_even_for_absent_optional_inputs() {
        for fabric in [false, true] {
            let source = DiscoveryDataSource {
                backend: Arc::new(ConfiguredBackend::default()),
                fabric,
            };
            let mut state = engine_config();
            state.fabric = fabric;
            if fabric {
                state.compute_driver = Value::Null;
                state.image = Value::Value("image:fixture".into());
            }
            let serialized = serde_json::to_value(&state).unwrap();
            let schema = source.schema(&mut Diagnostics::default()).unwrap();
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
            if fabric {
                assert!(serialized["requirements_json"].is_null());
            }
        }
    }
}
