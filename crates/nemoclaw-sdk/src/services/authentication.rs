// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Error, ObservationError, docker::Engine};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Source {
    OllamaProxy {
        storage: crate::managed::Storage,
        container: String,
        endpoint: String,
    },
    ManagedService {
        storage: crate::managed::Storage,
        container: String,
        endpoint: String,
    },
}
impl Source {
    fn fields(&self) -> (&crate::managed::Storage, &str, &str) {
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
            Self::ManagedService { .. } => ("inference-", "data", false),
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
    async fn container_id(&self, engine: &Engine) -> Result<String, Error> {
        let (storage, name, _) = self.fields();
        storage
            .observe(engine, "")
            .await?
            .ok_or(Error::Conflict("credential storage is absent"))?;
        let volume = &storage.name;
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
            let engine = Engine::connect(&self.fields().0.engine)?;
            let id = self.container_id(&engine).await?;
            match self {
                Self::ManagedService { .. } => read_key(&engine, &id).await,
                Self::OllamaProxy { .. } => read_proxy_key(&engine, &id).await,
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

async fn read_proxy_key(engine: &Engine, id: &str) -> Result<String, Error> {
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

#[cfg(test)]
mod durable_source_tests {
    use super::*;
    use serde_json::{Value, json};
    fn document(proxy: bool) -> crate::config::Document {
        let text = if proxy {
            include_str!("../../tests/fixtures/config/managed-ollama.yaml")
        } else {
            include_str!("../../tests/fixtures/config/spark.yaml")
        };
        let mut value: Value = serde_saphyr::from_str(text).unwrap();
        if proxy {
            value["spec"]["inferenceProviders"][0]["serviceRef"] = json!("ollama-auth");
            value["spec"]["services"] = json!({"ollama-auth":{"kind":"ollamaProxy","image":format!("proxy@sha256:{}","a".repeat(64)),"endpoint":"http://172.20.0.1:11435/v1","upstream":{"endpoint":"http://127.0.0.1:11434/v1","model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}}});
        } else {
            value["spec"]["services"]["qwen"]["authentication"] = json!("bearer");
        }
        crate::config::Document::parse(value.to_string().as_bytes()).unwrap()
    }
    fn provider(document: &crate::config::Document) -> crate::backend::Row {
        let generations = [
            "workspace",
            "provider",
            "sandbox",
            "managed_gateway",
            "inference_service",
            "ollama_proxy",
        ]
        .map(|kind| (kind.into(), "a".repeat(32)))
        .into();
        crate::compile::targets(document, &generations)
            .unwrap()
            .into_iter()
            .find(|target| target.kind == "provider")
            .unwrap()
            .values
    }
    #[test]
    fn remote_source_retains_published_endpoint_without_compute_configuration() {
        let mut document = crate::config::Document::parse(
            include_bytes!("../../../../examples/spark/remote-vllm.yaml").as_slice(),
        )
        .unwrap();
        let crate::services::ServiceDefinition::Vllm(service) =
            document.spec.services.get_mut("qwen").unwrap()
        else {
            panic!("vLLM example")
        };
        service.authentication =
            Some(crate::services::installers::vllm::ServiceAuthentication::Bearer);
        let row = provider(&document);
        let source = Source::parse(
            &row["credential_source"],
            &document.metadata.uid,
            &row["endpoint"],
        )
        .unwrap();
        assert!(source.fields().0.engine.starts_with("ssh://"));
        assert_eq!(source.fields().2, row["endpoint"]);
        assert!(!row["credential_source"].contains("sha256:"));
    }
    #[test]
    fn authenticated_image_replacement_preserves_registration_source() {
        for proxy in [false, true] {
            let original = document(proxy);
            let before = provider(&original);
            let mut value = serde_json::to_value(&original).unwrap();
            let name = if proxy { "ollama-auth" } else { "qwen" };
            value["spec"]["services"][name]["image"] =
                json!(format!("replacement@sha256:{}", "b".repeat(64)));
            let changed = crate::config::Document::parse(value.to_string().as_bytes()).unwrap();
            let after = provider(&changed);
            assert_eq!(
                before["credential_source"], after["credential_source"],
                "disposable image changes must not change durable registration identity"
            );
            Source::parse(
                &after["credential_source"],
                &changed.metadata.uid,
                &after["endpoint"],
            )
            .unwrap();
        }
    }
    #[test]
    fn durable_source_rejects_namespace_endpoint_and_unknown_fields() {
        for proxy in [false, true] {
            let document = document(proxy);
            let row = provider(&document);
            let text = &row["credential_source"];
            Source::parse(text, &document.metadata.uid, &row["endpoint"]).unwrap();
            assert!(Source::parse(text, "foreign", &row["endpoint"]).is_err());
            assert!(
                Source::parse(text, &document.metadata.uid, "http://127.0.0.1:1234/v1").is_err()
            );
            let original: Value = serde_json::from_str(text).unwrap();
            for field in ["container", "endpoint", "unknown"] {
                let mut changed = original.clone();
                changed[field] = json!("foreign");
                assert!(
                    Source::parse(
                        &changed.to_string(),
                        &document.metadata.uid,
                        &row["endpoint"]
                    )
                    .is_err()
                );
            }
            for field in ["Name", "Owner", "Generation", "Engine"] {
                let mut changed = original.clone();
                changed["storage"][field] = json!("foreign");
                assert!(
                    Source::parse(
                        &changed.to_string(),
                        &document.metadata.uid,
                        &row["endpoint"]
                    )
                    .is_err()
                );
            }
        }
    }
}
