// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! `host_image`: whether an engine holds an image with a platform, architecture,
//! and labels, without pulling it or starting anything.
use crate::{Error, ObservationError, docker::Connections, provider::ConfiguredBackend};
use async_trait::async_trait;
use nemoclaw_sdk::discovery::{ObservationStatus, RuntimeImageObservation};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct HostImageDataSource(pub Arc<ConfiguredBackend>);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct HostImageState {
    engine: Value<String>,
    image: Value<String>,
    architecture: Value<String>,
    labels: Value<BTreeMap<String, Value<String>>>,
    image_id: Value<String>,
    allow_missing: Value<bool>,
    observation_json: Value<String>,
}
/// The image required on an engine.
struct Requirements {
    engine: String,
    image: String,
    architecture: String,
    labels: BTreeMap<String, String>,
}
impl Requirements {
    /// The requirements, or `None` while any input is unknown.
    fn from_state(config: &HostImageState) -> Result<Option<Self>, Error> {
        let mut known = Vec::new();
        for (value, required) in [
            (&config.engine, "image engine is required"),
            (&config.image, "image is required"),
            (&config.architecture, "image architecture is required"),
        ] {
            match value {
                Value::Value(value) => known.push(value.clone()),
                Value::Unknown => {}
                Value::Null => return Err(Error::State(required)),
            }
        }
        let labels = match &config.labels {
            Value::Null => Some(BTreeMap::new()),
            Value::Unknown => None,
            Value::Value(labels) => labels
                .iter()
                .map(|(key, value)| match value {
                    Value::Value(value) => Ok(Some((key.clone(), value.clone()))),
                    Value::Unknown => Ok(None),
                    Value::Null => Err(Error::State("image label values are required")),
                })
                .collect::<Result<Option<_>, _>>()?,
        };
        let (Ok([engine, image, architecture]), Some(labels)) =
            (<[String; 3]>::try_from(known), labels)
        else {
            return Ok(None);
        };
        crate::config::validate_engine_endpoint(&engine)?;
        if !regex::Regex::new(r"^[^@\s]+@sha256:[a-f0-9]{64}$")
            .unwrap()
            .is_match(&image)
        {
            return Err(Error::Conflict("image must be pinned by SHA-256 digest"));
        }
        if !matches!(architecture.as_str(), "amd64" | "arm64") {
            return Err(Error::Conflict("image architecture must be amd64 or arm64"));
        }
        Ok(Some(Self {
            engine,
            image,
            architecture,
            labels,
        }))
    }
}
async fn observe(
    connections: &Connections,
    required: &Requirements,
    image_id: Option<&str>,
    allow_missing: bool,
) -> Result<RuntimeImageObservation, Error> {
    let image = tokio::time::timeout(
        Duration::from_secs(20),
        connections
            .resolve(&required.engine)?
            .image(&required.image),
    )
    .await
    .map_err(|_| ObservationError::Transport)??;
    let mut observation = RuntimeImageObservation {
        status: ObservationStatus::Unknown,
        source: "engine_image".into(),
    };
    let Some(image) = image else {
        if allow_missing && image_id.is_none() {
            return Ok(observation);
        }
        return Err(Error::Conflict(
            "image is absent from the selected engine; load the pinned image there or allow pulling",
        ));
    };
    if image.id.as_ref().is_none_or(String::is_empty)
        || image_id.is_some_and(|id| image.id.as_deref() != Some(id))
    {
        return Err(ObservationError::Incomplete.into());
    }
    let labels = image
        .config
        .as_ref()
        .and_then(|config| config.labels.as_ref());
    if image.os.as_deref() != Some("linux")
        || image.architecture.as_deref() != Some(required.architecture.as_str())
    {
        return Err(Error::Configuration(nemoclaw_sdk::config::ConfigError(
            format!("image platform is not linux/{}", required.architecture),
        )));
    }
    // Name the label, never the image's value.
    if let Some(key) = required
        .labels
        .iter()
        .find(|(key, value)| labels.and_then(|labels| labels.get(*key)) != Some(*value))
        .map(|(key, _)| key)
    {
        return Err(Error::Configuration(nemoclaw_sdk::config::ConfigError(
            format!("image label {key} is missing or does not match the required value"),
        )));
    }
    observation.status = ObservationStatus::Available;
    Ok(observation)
}
#[async_trait]
impl DataSource for HostImageDataSource {
    type State<'a> = HostImageState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, Map, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("engine", String, Required),
                    ("image", String, Required),
                    ("architecture", String, Required),
                    ("labels", Map(Box::new(String)), Optional),
                    ("image_id", String, Optional),
                    ("allow_missing", Bool, Optional),
                    ("observation_json", String, Computed),
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
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: HostImageState) -> Option<()> {
        let result = Requirements::from_state(&config).map(|_| ());
        match result {
            Ok(()) => Some(()),
            Err(error) => {
                diags.root_error("Invalid image requirements", error.to_string());
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: HostImageState,
        _: ValueEmpty,
    ) -> Option<HostImageState> {
        let work = async {
            let Some(required) = Requirements::from_state(&config)? else {
                return Err(Error::State("image requirements are not yet known"));
            };
            let image_id = match &config.image_id {
                Value::Null => None,
                Value::Value(id) if !id.is_empty() => Some(id.as_str()),
                _ => return Err(Error::State("image identity is not yet known")),
            };
            let allow_missing = match config.allow_missing {
                Value::Null => false,
                Value::Value(value) => value,
                Value::Unknown => {
                    return Err(Error::State("image acquisition policy is not yet known"));
                }
            };
            observe(self.0.connections(), &required, image_id, allow_missing).await
        }
        .await;
        match work {
            Ok(observation) => {
                config.observation_json =
                    Value::Value(serde_json::to_string(&observation).expect("image observation"));
                Some(config)
            }
            Err(error) => {
                diags.root_error("Image compatibility check failed", error.to_string());
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use nemoclaw_sdk::{compile, config::Document};
    use serde_json::json;

    #[test]
    fn requirements_validate_offline_and_defer_unknown_values() {
        let valid = || HostImageState {
            engine: Value::Value("unix:///var/run/docker.sock".into()),
            image: Value::Value(format!("runtime@sha256:{}", "a".repeat(64))),
            architecture: Value::Value("arm64".into()),
            labels: Value::Value(
                [("org.nemoclaw.backend".into(), Value::Value("vllm".into()))].into(),
            ),
            ..Default::default()
        };
        let required = Requirements::from_state(&valid()).unwrap().unwrap();
        assert_eq!(required.labels["org.nemoclaw.backend"], "vllm");
        let mut unlabeled = valid();
        unlabeled.labels = Value::Null;
        assert!(Requirements::from_state(&unlabeled).unwrap().is_some());
        for change in [
            |state: &mut HostImageState| state.image = Value::Unknown,
            |state: &mut HostImageState| state.labels = Value::Unknown,
            |state: &mut HostImageState| {
                state.labels =
                    Value::Value([("org.nemoclaw.backend".into(), Value::Unknown)].into())
            },
        ] {
            let mut state = valid();
            change(&mut state);
            assert!(Requirements::from_state(&state).unwrap().is_none());
        }
        for change in [
            |state: &mut HostImageState| state.image = Value::Null,
            |state: &mut HostImageState| state.image = Value::Value("runtime:latest".into()),
            |state: &mut HostImageState| state.architecture = Value::Value("riscv64".into()),
            |state: &mut HostImageState| state.engine = Value::Value("tcp://engine".into()),
        ] {
            let mut state = valid();
            change(&mut state);
            assert!(Requirements::from_state(&state).is_err());
        }
    }

    #[tokio::test]
    async fn image_contract_checks_are_read_only_and_fail_closed_before_acquisition() {
        for bytes in [
            include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/spark.yaml").as_slice(),
            include_bytes!("../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml")
                .as_slice(),
        ] {
            let mut document = Document::parse(bytes).unwrap();
            for service in document.spec.services.values_mut() {
                if let nemoclaw_sdk::services::ServiceDefinition::Vllm(service) = service {
                    service.authentication =
                        Some(nemoclaw_runtime::vllm::ServiceAuthentication::Bearer);
                }
            }
            let generations = [
                ("managed_gateway".into(), "a".repeat(32)),
                ("inference_service".into(), "b".repeat(32)),
                ("ollama_service".into(), "c".repeat(32)),
            ]
            .into();
            let target = compile::runtime_targets(&document, &generations)
                .unwrap()
                .into_iter()
                .find(|target| {
                    matches!(target.kind.as_str(), "inference_service" | "ollama_service")
                })
                .unwrap();
            let spec: nemoclaw_sdk::managed::Spec =
                serde_json::from_str(&target.values["spec"]).unwrap();
            let process = spec.process.as_ref().unwrap();
            let required = Requirements {
                engine: spec.engine().into(),
                image: spec.image().into(),
                architecture: process.architecture.clone(),
                labels: process.image_labels.clone(),
            };
            for variant in [
                "valid",
                "backend",
                "architecture",
                "identity",
                "absent",
                "authentication",
                "transport",
                "legacy_bearer_routes",
                "wrong_bearer_routes",
            ] {
                if variant.ends_with("bearer_routes")
                    && process.image_labels["org.nemoclaw.backend"] != "vllm"
                {
                    continue;
                }
                let mut image = json!({"Id":"sha256:runtime", "Os":"linux", "Architecture":process.architecture,
                    "Config":{"Labels":process.image_labels}});
                let code = match variant {
                    "absent" => 404,
                    "authentication" => 401,
                    "transport" => 500,
                    _ => 200,
                };
                match variant {
                    "backend" => {
                        image["Config"]["Labels"]["org.nemoclaw.backend"] =
                            json!("PRIVATE_SENTINEL")
                    }
                    "architecture" => image["Architecture"] = json!("PRIVATE_SENTINEL"),
                    "identity" => image["Id"] = json!(""),
                    "legacy_bearer_routes" => {
                        image["Config"]["Labels"]
                            .as_object_mut()
                            .unwrap()
                            .remove("org.nemoclaw.inference.routes");
                    }
                    "wrong_bearer_routes" => {
                        image["Config"]["Labels"]["org.nemoclaw.inference.routes"] =
                            json!("unrestricted")
                    }
                    _ => {}
                }
                let fixture = Fixture::engine(move |request| {
                    assert_eq!(request.method, "GET");
                    assert!(request.path.starts_with("/images/"));
                    Some((code, serde_json::to_vec(&image).unwrap()))
                })
                .await;
                let connections = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
                let result = observe(&connections, &required, None, true).await;
                match variant {
                    "valid" => {
                        assert_eq!(result.unwrap().status, ObservationStatus::Available);
                        assert!(
                            observe(&connections, &required, Some("sha256:other"), false)
                                .await
                                .is_err()
                        );
                        assert_eq!(
                            observe(&connections, &required, Some("sha256:runtime"), false)
                                .await
                                .unwrap()
                                .status,
                            ObservationStatus::Available
                        );
                    }
                    "absent" => {
                        assert_eq!(result.unwrap().status, ObservationStatus::Unknown);
                        assert!(observe(&connections, &required, None, false).await.is_err());
                        assert!(
                            observe(&connections, &required, Some("sha256:runtime"), true)
                                .await
                                .is_err()
                        );
                    }
                    _ => {
                        let message = result.unwrap_err().to_string();
                        assert!(!message.contains("PRIVATE_SENTINEL"), "{message}");
                        if variant == "backend" {
                            assert!(message.contains("org.nemoclaw.backend"), "{message}");
                        }
                        if variant.ends_with("bearer_routes") {
                            assert!(
                                message.contains("org.nemoclaw.inference.routes"),
                                "{message}"
                            );
                        }
                        if variant == "authentication" {
                            assert_eq!(message, "observation authentication failed");
                        }
                        if variant == "transport" {
                            assert_eq!(message, "observation transport failed");
                        }
                    }
                }
            }
        }
    }
}
