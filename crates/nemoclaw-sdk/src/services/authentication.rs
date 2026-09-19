// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, ObservationError, docker::Engine, services::installers::ollama::ProxySpec};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Source {
    OllamaProxy {
        engine: String,
        spec: Box<ProxySpec>,
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
                    && spec.settings.endpoint == endpoint => {}
            Self::ManagedService { spec }
                if spec.validate().is_ok()
                    && spec.owner == owner
                    && super::installers::vllm::configured_service(spec).is_ok_and(|service| {
                        service.authentication.is_some()
                            // Runtime configuration omits placement. The process
                            // binding retains the address actually published by Docker.
                            && spec.process.as_ref().is_some_and(|process| {
                                i64::from(process.port) == service.serving.port
                                    && endpoint == format!("http://{}:{}/v1", process.bind_address, process.port)
                            })
                    }) => {}
            _ => return Err(ObservationError::BindingMismatch),
        }
        Ok(source)
    }
    async fn container_id(&self, engine: &Engine) -> Result<String, Error> {
        let (name, volume) = match self {
            Self::ManagedService { spec } => {
                spec.validate()?;
                let storage = crate::managed::Storage {
                    name: spec.volume(),
                    owner: spec.owner.clone(),
                    generation: spec.generation.clone(),
                    engine: spec.engine().into(),
                };
                storage
                    .observe(engine, "")
                    .await?
                    .ok_or(Error::Conflict("credential storage is absent"))?;
                (spec.name.as_str(), spec.volume())
            }
            Self::OllamaProxy {
                engine: endpoint,
                spec,
            } => {
                if engine.endpoint() != endpoint {
                    return Err(ObservationError::BindingMismatch.into());
                }
                engine
                    .observe_ollama_proxy_storage(spec, "")
                    .await?
                    .ok_or(Error::Conflict("credential storage is absent"))?;
                (spec.name.as_str(), spec.volume())
            }
        };
        let container = engine
            .container(name)
            .await?
            .ok_or(Error::Conflict("credential source is absent"))?;
        if container
            .name
            .as_deref()
            .map(|name| name.trim_start_matches('/'))
            != Some(name)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        let mounts = container
            .mounts
            .as_ref()
            .ok_or(ObservationError::Incomplete)?;
        let data: Vec<_> = mounts
            .iter()
            .filter(|mount| {
                mount.destination.as_deref().is_some_and(|destination| {
                    destination == "/"
                        || destination == "/data"
                        || destination.starts_with("/data/")
                })
            })
            .collect();
        if data.len() != 1
            || data[0].destination.as_deref() != Some("/data")
            || data[0].typ.as_deref() != Some("volume")
            || data[0].name.as_deref() != Some(volume.as_str())
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        container
            .id
            .filter(|id| !id.is_empty())
            .ok_or(ObservationError::Incomplete.into())
    }
    pub async fn resolve(&self) -> Result<String, ObservationError> {
        let work = async {
            match self {
                Self::ManagedService { spec } => {
                    let engine = Engine::connect(spec.engine())?;
                    read_key(&engine, &self.container_id(&engine).await?).await
                }
                Self::OllamaProxy { engine, .. } => {
                    let engine = Engine::connect(engine)?;
                    read_key(&engine, &self.container_id(&engine).await?).await
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
    fn remote_credential_source_uses_the_published_process_endpoint() {
        let mut document = crate::config::Document::parse(
            include_bytes!("../../../../examples/spark/remote-vllm.yaml").as_slice(),
        )
        .unwrap();
        let crate::services::ServiceDefinition::Vllm(service) =
            document.spec.services.get_mut("qwen").unwrap()
        else {
            panic!("vLLM example");
        };
        service.authentication =
            Some(crate::services::installers::vllm::ServiceAuthentication::Bearer);
        let generations = [
            "workspace",
            "provider",
            "sandbox",
            "managed_gateway",
            "inference_service",
        ]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
        let targets = crate::compile::targets(&document, &generations).unwrap();
        let provider = &targets
            .iter()
            .find(|target| target.kind == "provider")
            .unwrap()
            .values;
        let source = &provider["credential_source"];
        Source::parse(source, &document.metadata.uid, &provider["endpoint"]).unwrap();
        assert!(Source::parse(source, "foreign", &provider["endpoint"]).is_err());
        let Source::ManagedService { spec } = serde_json::from_str(source).unwrap() else {
            panic!("managed credential");
        };
        let bridge_endpoint = format!(
            "http://{}:{}/v1",
            spec.bridge().unwrap(),
            spec.process.as_ref().unwrap().port
        );
        assert_ne!(bridge_endpoint, provider["endpoint"]);
        assert!(Source::parse(source, &document.metadata.uid, &bridge_endpoint).is_err());
    }

    #[test]
    fn credential_source_rejects_wrong_owner_endpoint_and_unsupported_image() {
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../managed/reference.json")).unwrap();
        let mut spec: Box<crate::managed::Spec> =
            serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
        let mut service = crate::services::installers::vllm::configured_service(&spec).unwrap();
        service.authentication =
            Some(crate::services::installers::vllm::ServiceAuthentication::Bearer);
        spec.process.as_mut().unwrap().configuration = serde_json::to_string(&service).unwrap();
        spec.process.as_mut().unwrap().image_labels.insert(
            "org.nemoclaw.inference.authentication".into(),
            "bearer-v1".into(),
        );
        let endpoint = format!(
            "http://{}:{}/v1",
            spec.bridge().unwrap(),
            service.serving.port
        );
        let source = serde_json::to_string(&Source::ManagedService { spec: spec.clone() }).unwrap();
        Source::parse(&source, &spec.owner, &endpoint).unwrap();
        assert!(Source::parse(&source, "foreign", &endpoint).is_err());
        assert!(Source::parse(&source, &spec.owner, "http://192.168.1.1:8080/v1").is_err());
        let mut image: bollard::models::ImageInspect = serde_json::from_value(
            serde_json::json!({"Id":"sha256:image","Architecture":"arm64","Os":"linux","Config":{"Labels":{}}}),
        )
        .unwrap();
        assert!(spec.validate_process_image(&image).is_err());
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
        image
            .config
            .as_mut()
            .unwrap()
            .labels
            .as_mut()
            .unwrap()
            .insert("org.nemoclaw.recipe.protocol".into(), "v1".into());
        image
            .config
            .as_mut()
            .unwrap()
            .labels
            .as_mut()
            .unwrap()
            .insert("org.nemoclaw.backend".into(), "vllm".into());
        spec.validate_process_image(&image).unwrap();
        service.authentication = None;
        spec.process.as_mut().unwrap().configuration = serde_json::to_string(&service).unwrap();
        let source = serde_json::to_string(&Source::ManagedService { spec: spec.clone() }).unwrap();
        assert!(Source::parse(&source, &spec.owner, &endpoint).is_err());
    }
}

#[cfg(all(test, unix))]
mod credential_boundary_tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn credentials_follow_owned_storage_not_disposable_compute_configuration() {
        let spec = ProxySpec {
            settings: crate::services::installers::ollama::ProxySettings {
                upstream: "http://127.0.0.1:11434/v1".into(),
                endpoint: "http://127.0.0.1:11435/v1".into(),
                model: "fixture:latest".into(),
                digest: "a".repeat(64),
            },
            image_pull_policy: None,
            name: "nc-0123456789abcdef-ollama-proxy-fixture".into(),
            owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13".into(),
            generation: "b".repeat(32),
            image: format!("proxy@sha256:{}", "a".repeat(64)),
            bind_address: "127.0.0.1:11435".into(),
        };
        let volume = Arc::new(Mutex::new(
            json!({"Name":spec.volume(),"Driver":"local","Scope":"local","Options":{},"Mountpoint":"/var/lib/docker/volumes/auth/_data","CreatedAt":"created","Labels":{crate::managed::OWNER_LABEL:spec.owner,crate::managed::GENERATION_LABEL:spec.generation}}),
        ));
        let container = Arc::new(Mutex::new(
            json!({"Id":"new-provider-id","Name":format!("/{}",spec.name),"Mounts":[{"Type":"volume","Name":spec.volume(),"Destination":"/data"}]}),
        ));
        let shared_volume = volume.clone();
        let shared_container = container.clone();
        let fixture = Fixture::start(move |request| {
            assert_eq!(request.method, "GET");
            let response = if request.path == "/info" {
                json!({"ID":"daemon"})
            } else if request.path.starts_with("/volumes/") {
                shared_volume.lock().unwrap().clone()
            } else if request.path.starts_with("/containers/") {
                shared_container.lock().unwrap().clone()
            } else {
                panic!(
                    "unexpected compute/configuration prerequisite {}",
                    request.path
                )
            };
            Some((200, serde_json::to_vec(&response).unwrap()))
        })
        .await;
        let source = Source::OllamaProxy {
            engine: fixture.endpoint.clone(),
            spec: Box::new(spec),
        };
        let engine = Engine::connect(&fixture.endpoint).unwrap();
        assert_eq!(
            source.container_id(&engine).await.unwrap(),
            "new-provider-id"
        );
        volume.lock().unwrap()["Labels"][crate::managed::OWNER_LABEL] = json!("foreign");
        assert!(source.container_id(&engine).await.is_err());
        volume.lock().unwrap()["Labels"][crate::managed::OWNER_LABEL] =
            json!("302ff5e1-088d-42ce-959f-4ff4c3570c13");
        container.lock().unwrap()["Mounts"][0]["Name"] = json!("other-data");
        assert!(source.container_id(&engine).await.is_err());
    }
}
