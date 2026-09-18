// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, ObservationError, docker::Engine, services::installers::ollama::ServiceSpec};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Source {
    OllamaProxy {
        engine: String,
        spec: Box<ServiceSpec>,
    },
    ManagedService {
        spec: Box<crate::managed::Spec>,
    },
}
impl Source {
    pub(crate) fn json(&self) -> Result<String, crate::config::ConfigError> {
        let source = serde_json::to_string(self).expect("typed credential source");
        crate::openshell::credential_metadata::pack(&source).map_err(|_| {
            crate::config::ConfigError::new(
                "managed credential reference exceeds gateway annotation capacity",
            )
        })?;
        Ok(source)
    }

    pub fn parse(value: &str, owner: &str, endpoint: &str) -> Result<Self, ObservationError> {
        let source: Self = serde_json::from_str(value).map_err(|_| ObservationError::Incomplete)?;
        match &source {
            Self::OllamaProxy { engine, spec }
                if engine.starts_with("unix:///")
                    && Engine::validate_endpoint(engine).is_ok()
                    && spec.validate().is_ok()
                    && spec.owner == owner
                    && spec.proxy.as_ref().is_some_and(|p| p.endpoint == endpoint) => {}
            Self::ManagedService { spec }
                if spec.validate().is_ok()
                    && spec.owner == owner
                    && spec.service.as_ref().is_some_and(|s| {
                        s.authentication.is_some()
                            && s.publication.as_ref().map_or_else(
                                || {
                                    spec.bridge().is_ok_and(|b| {
                                        endpoint == format!("http://{b}:{}/v1", s.serving.port)
                                    })
                                },
                                |p| p.endpoint == endpoint,
                            )
                    }) => {}
            _ => return Err(ObservationError::BindingMismatch),
        }
        Ok(source)
    }
    pub async fn resolve(&self) -> Result<String, ObservationError> {
        let work = async {
            match self {
                Self::ManagedService { spec } => {
                    let engine = Engine::connect(spec.engine())?;
                    let observed = engine
                        .observe_runtime(spec, "")
                        .await?
                        .ok_or(Error::Conflict("credential source is absent"))?;
                    read_key(&engine, &observed.container_id).await
                }
                Self::OllamaProxy { engine, spec } => {
                    let engine = Engine::connect(engine)?;
                    let observed = engine
                        .observe_ollama(spec, "")
                        .await?
                        .ok_or(Error::Conflict("credential source is absent"))?;
                    let id = observed
                        .id
                        .split('/')
                        .nth(1)
                        .ok_or(Error::State("invalid credential source identity"))?;
                    read_key(&engine, id).await
                }
            }
        };
        work.await.map_err(|_| ObservationError::Authentication)
    }
}
pub(crate) async fn read_key(engine: &Engine, id: &str) -> Result<String, Error> {
    let path = "/data/inference-key";
    let stat = engine
        .stat_file(id, path)
        .await?
        .ok_or(Error::State("managed inference credential is missing"))?;
    if stat.size != 64
        || stat.file_mode & 0o777 != 0o600
        || stat.file_mode & !0o777 != 0
        || !stat.link_target.is_empty()
    {
        return Err(Error::State(
            "managed inference credential metadata is invalid",
        ));
    }
    let bytes = engine
        .read_file(id, path, 64)
        .await?
        .ok_or(Error::State("managed inference credential is missing"))?;
    if bytes.len() != 64
        || !bytes
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return Err(Error::State("managed inference credential is invalid"));
    }
    String::from_utf8(bytes).map_err(|_| Error::State("managed inference credential is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_source_rejects_wrong_owner_endpoint_and_unsupported_image() {
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../managed/reference.json")).unwrap();
        let mut spec: Box<crate::managed::Spec> =
            serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
        spec.service.as_mut().unwrap().authentication =
            Some(crate::config::ServiceAuthentication::Bearer);
        let endpoint = format!(
            "http://{}:{}/v1",
            spec.bridge().unwrap(),
            spec.service.as_ref().unwrap().serving.port
        );
        let source = serde_json::to_string(&Source::ManagedService { spec: spec.clone() }).unwrap();
        Source::parse(&source, &spec.owner, &endpoint).unwrap();
        assert!(Source::parse(&source, "foreign", &endpoint).is_err());
        assert!(Source::parse(&source, &spec.owner, "http://192.168.1.1:8080/v1").is_err());
        let mut image: bollard::models::ImageInspect =
            serde_json::from_value(serde_json::json!({"Config":{"Labels":{}}})).unwrap();
        assert!(spec.validate_image_authentication(&image).is_err());
        image
            .config
            .as_mut()
            .unwrap()
            .labels
            .as_mut()
            .unwrap()
            .insert(
                "org.nemoclaw.inference.authentication".into(),
                "bearer-v1".into(),
            );
        spec.validate_image_authentication(&image).unwrap();
        spec.service.as_mut().unwrap().authentication = None;
        let source = serde_json::to_string(&Source::ManagedService { spec: spec.clone() }).unwrap();
        assert!(Source::parse(&source, &spec.owner, &endpoint).is_err());
    }
}
