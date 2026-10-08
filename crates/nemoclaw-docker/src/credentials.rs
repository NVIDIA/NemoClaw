// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed service credentials: where a key lives, and its bounded read from
//! the owning container, so that the key never enters OpenTofu state.

use crate::Storage;
use nemoclaw_backend::ObservationError;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Source {
    OllamaProxy {
        storage: Storage,
        container: String,
        endpoint: String,
    },
    ManagedService {
        storage: Storage,
        container: String,
        endpoint: String,
    },
}
impl Source {
    pub fn fields(&self) -> (&Storage, &str, &str) {
        match self {
            Self::OllamaProxy {
                storage,
                container,
                endpoint,
            }
            | Self::ManagedService {
                storage,
                container,
                endpoint,
            } => (storage, container, endpoint),
        }
    }
    pub fn parse(value: &str, owner: &str, endpoint: &str) -> Result<Self, ObservationError> {
        let source: Self = serde_json::from_str(value).map_err(|_| ObservationError::Incomplete)?;
        use sha2::{Digest, Sha256};
        let (storage, container, published) = source.fields();
        let prefix = format!(
            "nc-{}-",
            Sha256::digest(owner.as_bytes())[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let (kind, suffix, local) = match source {
            Self::OllamaProxy { .. } => ("ollama-proxy-", "auth", true),
            Self::ManagedService { .. } => ("inference-", "auth", false),
        };
        let namespace = format!("{prefix}{kind}");
        let name = container.strip_prefix(&namespace);
        let address = published
            .strip_prefix("http://")
            .and_then(|s| s.strip_suffix("/v1"))
            .and_then(|s| s.parse::<std::net::SocketAddr>().ok());
        let private = address.is_some_and(|address| {
            address.port() != 0
                && match address.ip() {
                    std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_loopback(),
                    std::net::IpAddr::V6(ip) => local && (ip.is_unique_local() || ip.is_loopback()),
                }
        });
        if storage.validate().is_err()
            || storage.owner != owner
            || published != endpoint
            || !private
            || (local && !storage.engine.starts_with("unix:///"))
            || !name.is_some_and(|name| {
                regex::Regex::new(r"^[a-z][a-z0-9-]*$")
                    .unwrap()
                    .is_match(name)
            })
            || storage.name != format!("{container}-{suffix}")
        {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(source)
    }
}

#[cfg(feature = "client")]
mod reader {
    use super::Source;
    use crate::Engine;
    use nemoclaw_backend::{Error, ObservationError};

    async fn container_id(source: &Source, engine: &Engine) -> Result<String, Error> {
        let (storage, name, _) = source.fields();
        crate::observe_storage(storage, engine, "")
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
                    path == "/"
                        || path == destination
                        || path.starts_with(&format!("{destination}/"))
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
    pub async fn read_service_key(engine: &Engine, id: &str) -> Result<String, Error> {
        read_key_at(engine, id, "/credentials/inference-key").await
    }
    pub async fn read_key(engine: &Engine, id: &str) -> Result<String, Error> {
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
        String::from_utf8(bytes)
            .map_err(|_| Error::State("managed inference credential is invalid"))
    }

    pub async fn read_proxy_key(engine: &Engine, id: &str) -> Result<String, Error> {
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
    mod credential_boundary_tests {
        use super::*;
        use crate::fixture::Fixture;
        use serde_json::json;
        use std::sync::{Arc, Mutex};
        #[tokio::test]
        async fn credentials_follow_owned_storage_not_disposable_compute_configuration() {
            let name = "nc-0123456789abcdef-ollama-proxy-fixture";
            let volume_name = format!("{name}-auth");
            let owner = "302ff5e1-088d-42ce-959f-4ff4c3570c13";
            let generation = "b".repeat(32);
            let volume = Arc::new(Mutex::new(
                json!({"Name":volume_name,"Driver":"local","Scope":"local","Options":{},"Mountpoint":"/var/lib/docker/volumes/auth/_data","CreatedAt":"created","Labels":{crate::OWNER_LABEL:owner,crate::GENERATION_LABEL:generation}}),
            ));
            let container = Arc::new(Mutex::new(
                json!({"Id":"new-provider-id","Name":format!("/{name}"),"Mounts":[{"Type":"volume","Name":volume_name,"Destination":"/data"}]}),
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
                storage: crate::Storage {
                    name: volume_name,
                    owner: owner.into(),
                    generation: generation.clone(),
                    engine: fixture.endpoint.clone(),
                },
                container: name.into(),
                endpoint: "http://127.0.0.1:11435/v1".into(),
            };
            let engine = Engine::connect(&fixture.endpoint).unwrap();
            assert_eq!(
                container_id(&source, &engine).await.unwrap(),
                "new-provider-id"
            );
            volume.lock().unwrap()["Labels"][crate::OWNER_LABEL] = json!("foreign");
            assert!(container_id(&source, &engine).await.is_err());
            volume.lock().unwrap()["Labels"][crate::OWNER_LABEL] =
                json!("302ff5e1-088d-42ce-959f-4ff4c3570c13");
            container.lock().unwrap()["Mounts"][0]["Name"] = json!("other-data");
            assert!(container_id(&source, &engine).await.is_err());
        }
    }
}
#[cfg(all(test, unix, feature = "client"))]
#[path = "credentials_wait_tests.rs"]
mod wait_tests;
#[cfg(feature = "client")]
pub use reader::{read_key, read_proxy_key, read_service_key, resolve};
