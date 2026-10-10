// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Read the runtime's image contract without acquiring images or creating resources.
use crate::{Error, ObservationError, docker::Connections, provider::ConfiguredBackend};
use async_trait::async_trait;
use nemoclaw_sdk::{
    discovery::{ObservationStatus, RuntimeImageObservation},
    managed::{RUNTIME_SPEC_VERSION, RUNTIME_SPEC_VERSION_LABEL},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct RuntimeImageDataSource(pub Arc<ConfiguredBackend>);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct RuntimeImageState {
    engine: Value<String>,
    image: Value<String>,
    architecture: Value<String>,
    labels: Value<BTreeMap<String, Value<String>>>,
    image_id: Value<String>,
    allow_missing: Value<bool>,
    observation_json: Value<String>,
}
/// The image a service runtime requires on its engine.
struct Requirements {
    engine: String,
    image: String,
    architecture: String,
    labels: BTreeMap<String, String>,
}
impl Requirements {
    /// The requirements, or `None` while any input is unknown.
    fn from_state(config: &RuntimeImageState) -> Result<Option<Self>, Error> {
        let mut known = Vec::new();
        for (value, required) in [
            (&config.engine, "runtime image engine is required"),
            (&config.image, "runtime image is required"),
            (
                &config.architecture,
                "runtime image architecture is required",
            ),
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
                    Value::Null => Err(Error::State("runtime image label values are required")),
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
            return Err(Error::Conflict(
                "runtime image must be pinned by SHA-256 digest",
            ));
        }
        if !matches!(architecture.as_str(), "amd64" | "arm64") {
            return Err(Error::Conflict(
                "runtime image architecture must be amd64 or arm64",
            ));
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
        required_version: RUNTIME_SPEC_VERSION.into(),
    };
    let Some(image) = image else {
        if allow_missing && image_id.is_none() {
            return Ok(observation);
        }
        return Err(Error::Conflict(
            "runtime image is absent from the selected engine; load the pinned image there or allow pulling",
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
    if labels
        .and_then(|labels| labels.get(RUNTIME_SPEC_VERSION_LABEL))
        .map(String::as_str)
        != Some(RUNTIME_SPEC_VERSION)
    {
        return Err(Error::Configuration(nemoclaw_sdk::config::ConfigError(
            format!(
                "runtime image does not support runtime specification {RUNTIME_SPEC_VERSION}; rebuild the runtime image with this revision's nemoclaw-build runtime command and update the image digest (docs/build.md)"
            ),
        )));
    }
    if image.os.as_deref() != Some("linux")
        || image.architecture.as_deref() != Some(required.architecture.as_str())
        || required
            .labels
            .iter()
            .any(|(key, value)| labels.and_then(|labels| labels.get(key)) != Some(value))
    {
        return Err(Error::Conflict(
            "runtime image platform or required backend, recipe, or authentication labels are incompatible; rebuild the runtime image and update its digest",
        ));
    }
    observation.status = ObservationStatus::Available;
    Ok(observation)
}
#[async_trait]
impl DataSource for RuntimeImageDataSource {
    type State<'a> = RuntimeImageState;
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
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: RuntimeImageState) -> Option<()> {
        let result = Requirements::from_state(&config).map(|_| ());
        match result {
            Ok(()) => Some(()),
            Err(error) => {
                diags.root_error("Invalid runtime image requirements", error.to_string());
                None
            }
        }
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: RuntimeImageState,
        _: ValueEmpty,
    ) -> Option<RuntimeImageState> {
        let work = async {
            let Some(required) = Requirements::from_state(&config)? else {
                return Err(Error::State("runtime image requirements are not yet known"));
            };
            let image_id = match &config.image_id {
                Value::Null => None,
                Value::Value(id) if !id.is_empty() => Some(id.as_str()),
                _ => return Err(Error::State("runtime image identity is not yet known")),
            };
            let allow_missing = match config.allow_missing {
                Value::Null => false,
                Value::Value(value) => value,
                Value::Unknown => {
                    return Err(Error::State(
                        "runtime image acquisition policy is not yet known",
                    ));
                }
            };
            observe(self.0.connections(), &required, image_id, allow_missing).await
        }
        .await;
        match work {
            Ok(observation) => {
                config.observation_json = Value::Value(
                    serde_json::to_string(&observation).expect("runtime image observation"),
                );
                Some(config)
            }
            Err(error) => {
                diags.root_error(
                    "Runtime image compatibility check failed",
                    error.to_string(),
                );
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
        let valid = || RuntimeImageState {
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
            |state: &mut RuntimeImageState| state.image = Value::Unknown,
            |state: &mut RuntimeImageState| state.labels = Value::Unknown,
            |state: &mut RuntimeImageState| {
                state.labels =
                    Value::Value([("org.nemoclaw.backend".into(), Value::Unknown)].into())
            },
        ] {
            let mut state = valid();
            change(&mut state);
            assert!(Requirements::from_state(&state).unwrap().is_none());
        }
        for change in [
            |state: &mut RuntimeImageState| state.image = Value::Null,
            |state: &mut RuntimeImageState| state.image = Value::Value("runtime:latest".into()),
            |state: &mut RuntimeImageState| state.architecture = Value::Value("riscv64".into()),
            |state: &mut RuntimeImageState| state.engine = Value::Value("tcp://engine".into()),
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
            let document = Document::parse(bytes).unwrap();
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
                "missing",
                "version",
                "backend",
                "architecture",
                "identity",
                "absent",
                "authentication",
                "transport",
            ] {
                let mut image = json!({"Id":"sha256:runtime", "Os":"linux", "Architecture":process.architecture,
                    "Config":{"Labels":process.image_labels}});
                let code = match variant {
                    "absent" => 404,
                    "authentication" => 401,
                    "transport" => 500,
                    _ => 200,
                };
                match variant {
                    "missing" => {
                        image["Config"]["Labels"]
                            .as_object_mut()
                            .unwrap()
                            .remove(RUNTIME_SPEC_VERSION_LABEL);
                    }
                    "version" => {
                        image["Config"]["Labels"][RUNTIME_SPEC_VERSION_LABEL] =
                            json!("PRIVATE_SENTINEL")
                    }
                    "backend" => {
                        image["Config"]["Labels"]["org.nemoclaw.backend"] =
                            json!("PRIVATE_SENTINEL")
                    }
                    "architecture" => image["Architecture"] = json!("PRIVATE_SENTINEL"),
                    "identity" => image["Id"] = json!(""),
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
                        if matches!(variant, "missing" | "version") {
                            assert!(message.contains("runtime specification v1"), "{message}");
                            assert!(message.contains("rebuild"));
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
