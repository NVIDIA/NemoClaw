// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, ObservationError, docker::Engine};
use nemoclaw_sdk::services::authentication::Source;
async fn container_id(source: &Source, engine: &Engine) -> Result<String, Error> {
    let (storage, name, _) = source.fields();
    crate::managed::observe_storage(storage, engine, "")
        .await?
        .ok_or(Error::Conflict("credential storage is absent"))?;
    let volume = &storage.name;
    let destination = match source {
        Source::ManagedService { .. } => "/credentials",
        Source::OllamaProxy { .. } => "/data",
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
            mount.destination.as_deref().is_some_and(|path| {
                path == "/" || path == destination || path.starts_with(&format!("{destination}/"))
            })
        })
        .collect();
    if data.len() != 1
        || data[0].destination.as_deref() != Some(destination)
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
pub async fn resolve(source: &Source) -> Result<String, ObservationError> {
    let work = async {
        let engine = Engine::connect(&source.fields().0.engine)?;
        let id = container_id(source, &engine).await?;
        match source {
            Source::ManagedService { .. } => read_service_key(&engine, &id).await,
            Source::OllamaProxy { .. } => read_proxy_key(&engine, &id).await,
        }
    };
    work.await.map_err(|_| ObservationError::Authentication)
}
pub(crate) async fn read_service_key(engine: &Engine, id: &str) -> Result<String, Error> {
    read_key_at(engine, id, "/credentials/inference-key").await
}
pub(crate) async fn read_key(engine: &Engine, id: &str) -> Result<String, Error> {
    read_key_at(engine, id, "/data/inference-key").await
}
async fn read_key_at(engine: &Engine, id: &str, path: &str) -> Result<String, Error> {
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

#[cfg(all(test, unix))]
mod credential_boundary_tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use crate::services::installers::ollama::ProxySpec;
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
            storage: crate::managed::Storage {
                name: spec.volume(),
                owner: spec.owner.clone(),
                generation: spec.generation.clone(),
                engine: fixture.endpoint.clone(),
            },
            container: spec.name.clone(),
            endpoint: spec.settings.endpoint.clone(),
        };
        let engine = Engine::connect(&fixture.endpoint).unwrap();
        assert_eq!(
            container_id(&source, &engine).await.unwrap(),
            "new-provider-id"
        );
        volume.lock().unwrap()["Labels"][crate::managed::OWNER_LABEL] = json!("foreign");
        assert!(container_id(&source, &engine).await.is_err());
        volume.lock().unwrap()["Labels"][crate::managed::OWNER_LABEL] =
            json!("302ff5e1-088d-42ce-959f-4ff4c3570c13");
        container.lock().unwrap()["Mounts"][0]["Name"] = json!("other-data");
        assert!(container_id(&source, &engine).await.is_err());
    }
}

pub(super) async fn read_proxy_key(engine: &Engine, id: &str) -> Result<String, Error> {
    let work = async {
        loop {
            match read_key(engine, id).await {
                Err(error @ Error::State("managed inference credential is missing")) => {
                    // Initial startup may not have created the key yet. An
                    // initialized volume must never recover by replacing it.
                    if engine.stat_file(id, "/data/initialized").await?.is_some()
                        || !engine
                            .container(id)
                            .await?
                            .and_then(|container| container.state)
                            .and_then(|state| state.running)
                            .unwrap_or(false)
                    {
                        return Err(error);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                result => return result,
            }
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), work)
        .await
        .map_err(|_| {
            Error::State("proxy credential readiness timed out; identity and storage retained")
        })?
}
#[cfg(all(test, unix))]
#[path = "authentication_wait_tests.rs"]
mod wait_tests;
