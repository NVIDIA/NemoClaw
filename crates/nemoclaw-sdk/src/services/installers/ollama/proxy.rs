// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::OllamaProxy;
use super::*;
use crate::{
    Error, ObservationError,
    backend::Row,
    compile::{Generations, Target},
    config::Document,
};
use bollard::models::{ImageInspect, SystemInfo};
use std::collections::BTreeSet;
pub const PROXY: &str = "ollama_proxy";
pub const STORAGE: &str = "ollama_proxy_storage";
pub const MODEL: &str = "ollama_external_model";
pub fn supports(kind: &str) -> bool {
    matches!(kind, PROXY | STORAGE | MODEL)
}

fn compatible_architecture(image: Option<&str>, engine: Option<&str>) -> bool {
    matches!(
        (image, engine),
        (Some("amd64"), Some("amd64" | "x86_64")) | (Some("arm64"), Some("arm64" | "aarch64"))
    )
}

fn local_image_digest(image: &ImageInspect, engine: &SystemInfo) -> Result<String, Error> {
    let valid_identity = image.id.as_deref().is_some_and(|id| {
        regex::Regex::new("^sha256:[a-f0-9]{64}$")
            .unwrap()
            .is_match(id)
    });
    let valid_entrypoint = image
        .config
        .as_ref()
        .and_then(|config| config.entrypoint.as_deref())
        .is_some_and(|entrypoint| entrypoint == ["python3", "/opt/nemoclaw/ollama_proxy.py"]);
    if !valid_identity
        || image.os.as_deref() != Some("linux")
        || engine.os_type.as_deref() != Some("linux")
        || !compatible_architecture(
            image.architecture.as_deref(),
            engine.architecture.as_deref(),
        )
        || !valid_entrypoint
    {
        return Err(Error::Conflict(
            "local Ollama proxy image has incompatible provenance",
        ));
    }
    let repository = crate::config::LOCAL_OLLAMA_PROXY_IMAGE
        .split_once(':')
        .map(|(repository, _)| repository)
        .ok_or(Error::State("invalid local Ollama proxy image tag"))?;
    let digests: BTreeSet<_> = image
        .repo_digests
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|digest| {
            digest
                .strip_prefix(&format!("{repository}@sha256:"))
                .is_some_and(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
        })
        .cloned()
        .collect();
    match digests.into_iter().collect::<Vec<_>>().as_slice() {
        [digest] => Ok(digest.clone()),
        _ => Err(Error::Conflict(
            "local Ollama proxy image requires one immutable RepoDigest",
        )),
    }
}

pub(crate) async fn resolve_images(
    document: &mut Document,
    engines: &crate::docker::Connections,
) -> Result<(), Error> {
    let gateway_engine = document.spec.gateway.engine.clone();
    let unresolved: Vec<_> = document
        .spec
        .services
        .iter()
        .filter_map(|(name, definition)| match definition {
            crate::services::ServiceDefinition::OllamaProxy(proxy) if proxy.image.is_empty() => {
                Some((
                    name.clone(),
                    proxy
                        .engine
                        .clone()
                        .unwrap_or_else(|| gateway_engine.clone()),
                ))
            }
            _ => None,
        })
        .collect();
    for (name, endpoint) in unresolved {
        let engine = engines.resolve(&endpoint)?;
        let info = engine.info().await?;
        let image = engine
            .image(crate::config::LOCAL_OLLAMA_PROXY_IMAGE)
            .await?
            .ok_or(Error::Conflict(
                "local Ollama proxy image is absent; build the repository target first",
            ))?;
        let digest = local_image_digest(&image, &info)?;
        let Some(crate::services::ServiceDefinition::OllamaProxy(proxy)) =
            document.spec.services.get_mut(&name)
        else {
            return Err(Error::State("missing Ollama proxy service"));
        };
        proxy.image = digest;
    }
    Ok(())
}
pub fn specification(
    document: &Document,
    service_name: &str,
    proxy: &OllamaProxy,
    generations: &Generations,
) -> Result<ProxySpec, Error> {
    let spec = ProxySpec {
        name: format!("{}-ollama-proxy-{service_name}", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generations
            .get(PROXY)
            .ok_or(Error::State("missing proxy generation"))?
            .clone(),
        image: proxy.image.clone(),
        image_pull_policy: proxy.image_pull_policy,
        bind_address: match super::reserved_proxy_port(&proxy.endpoint) {
            Some(port) => format!("{}:{port}", document.spec.gateway.bridge()?),
            None => proxy
                .endpoint
                .strip_prefix("http://")
                .and_then(|s| s.strip_suffix("/v1"))
                .ok_or(Error::State("invalid proxy endpoint"))?
                .into(),
        },
        settings: ProxySettings {
            upstream: proxy.upstream.endpoint.clone(),
            endpoint: proxy.endpoint.clone(),
            model: proxy.upstream.model.name.clone(),
            digest: proxy.upstream.model.digest.clone(),
        },
    };
    spec.validate()?;
    Ok(spec)
}
pub fn row_spec(row: &Row) -> Result<ProxySpec, Error> {
    let get = |name: &str| {
        row.get(name)
            .filter(|s| !s.is_empty())
            .cloned()
            .ok_or(Error::State("incomplete proxy resource"))
    };
    let binding = get("bind_address")?;
    let spec = ProxySpec {
        name: get("name")?,
        owner: get("owner")?,
        generation: get("generation")?,
        image: get("image")?,
        image_pull_policy: crate::config::ImagePullPolicy::from_row(row)?,
        settings: ProxySettings {
            upstream: get("upstream")?,
            endpoint: row
                .get("endpoint")
                .filter(|endpoint| !endpoint.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("http://{binding}/v1")),
            model: get("model")?,
            digest: get("digest")?,
        },
        bind_address: binding,
    };
    spec.validate()?;
    Ok(spec)
}
pub fn targets(
    document: &Document,
    service_name: &str,
    proxy: &OllamaProxy,
    generations: &Generations,
) -> Result<Vec<Target>, Error> {
    let spec = specification(document, service_name, proxy, generations)?;
    let settings = &spec.settings;
    let mut common: Row = [
        ("name", spec.name.clone()),
        ("owner", spec.owner.clone()),
        ("generation", spec.generation.clone()),
        ("image", spec.image.clone()),
        ("bind_address", spec.bind_address.clone()),
        ("upstream", settings.upstream.clone()),
        ("model", settings.model.clone()),
        ("digest", settings.digest.clone()),
        ("engine", proxy.engine(document).into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    if let Some(policy) = spec.image_pull_policy {
        common.insert("image_pull_policy".into(), policy.as_str().into());
    }
    common.insert("endpoint".into(), settings.endpoint.clone());
    Ok([STORAGE, PROXY, MODEL]
        .into_iter()
        .map(|kind| {
            let mut values = common.clone();
            if kind == PROXY {
                values.insert("running".into(), "true".into());
            } else {
                values.retain(|key, _| {
                    matches!(key.as_str(), "name" | "owner" | "generation" | "engine")
                        || (kind == MODEL
                            && matches!(key.as_str(), "upstream" | "model" | "digest"))
                });
            }
            Target {
                kind: kind.into(),
                address: format!("nemoclaw_{kind}.{service_name}"),
                values,
            }
        })
        .collect())
}
pub async fn verify_model(settings: &ProxySettings) -> Result<(), Error> {
    let model = Models::new(&settings.upstream)?
        .read(&settings.model)
        .await?
        .ok_or(Error::Conflict(
            "external Ollama model is absent; installation is not managed",
        ))?;
    if model.digest != settings.digest {
        return Err(Error::Conflict("external Ollama model digest changed"));
    }
    Ok(())
}
fn auxiliary_storage(row: &Row) -> Result<crate::managed::Storage, Error> {
    let get = |field| {
        row.get(field)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or(ObservationError::Incomplete)
    };
    let storage = crate::managed::Storage {
        name: format!("{}-auth", get("name")?),
        owner: get("owner")?,
        generation: get("generation")?,
        engine: get("engine")?,
    };
    storage.validate()?;
    Ok(storage)
}
fn model_settings(row: &Row) -> Result<ProxySettings, Error> {
    let get = |field| {
        row.get(field)
            .filter(|value| !value.is_empty())
            .cloned()
            .ok_or(ObservationError::Incomplete)
    };
    let settings = ProxySettings {
        upstream: get("upstream")?,
        model: get("model")?,
        digest: get("digest")?,
        endpoint: String::new(),
    };
    Models::new(&settings.upstream)?;
    let upstream = url::Url::parse(&settings.upstream).map_err(|_| ObservationError::Incomplete)?;
    if upstream.port().is_none()
        || !match upstream.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        }
        || !regex::Regex::new(super::MODEL_PATTERN)
            .unwrap()
            .is_match(&settings.model)
        || !regex::Regex::new("^[a-f0-9]{64}$")
            .unwrap()
            .is_match(&settings.digest)
    {
        return Err(Error::Conflict("invalid external Ollama model observation"));
    }
    Ok(settings)
}
impl ProxyBackend {
    pub(super) async fn proxy_read(
        &self,
        kind: &str,
        row: &Row,
        apply: bool,
        removing: bool,
    ) -> Result<Option<Row>, Error> {
        if !supports(kind) {
            return Err(ObservationError::Query.into());
        }
        let id = row.get("id").map(String::as_str).unwrap_or("");
        let mut result = row.clone();
        if kind == MODEL {
            let storage = auxiliary_storage(row)?;
            let settings = model_settings(row)?;
            if !removing {
                verify_model(&settings).await?;
            }
            let expected = format!(
                "{}/{}/{}",
                storage.owner, storage.generation, settings.digest
            );
            if !id.is_empty() && id != expected {
                return Err(ObservationError::BindingMismatch.into());
            }
            result.insert("id".into(), expected);
            return Ok(Some(result));
        }
        if kind == STORAGE {
            let storage = auxiliary_storage(row)?;
            let observed = if apply {
                Some(storage.ensure(&self.engine, id).await?)
            } else {
                storage.observe(&self.engine, id).await?
            };
            return Ok(observed.map(|id| {
                result.insert("id".into(), id);
                result
            }));
        }
        Err(Error::State(
            "proxy lifecycle belongs to the Docker provider",
        ))
    }
    pub(super) async fn proxy_remove(&self, kind: &str, row: &Row) -> Result<(), Error> {
        if kind == STORAGE {
            return Err(Error::Conflict("proxy credential storage is retained"));
        }
        if kind == MODEL {
            self.proxy_read(kind, row, false, true).await?;
            return Ok(());
        }
        if !supports(kind) {
            return Err(ObservationError::Query.into());
        }
        Err(Error::State(
            "proxy lifecycle belongs to the Docker provider",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn image(digests: Vec<String>) -> ImageInspect {
        serde_json::from_value(json!({
            "Id": format!("sha256:{}", "b".repeat(64)),
            "RepoDigests": digests,
            "Architecture": "arm64",
            "Os": "linux",
            "Config": {"Entrypoint": ["python3", "/opt/nemoclaw/ollama_proxy.py"]}
        }))
        .unwrap()
    }

    fn engine(architecture: &str) -> SystemInfo {
        serde_json::from_value(json!({
            "ID":"daemon",
            "OSType":"linux",
            "Architecture":architecture
        }))
        .unwrap()
    }

    #[test]
    fn local_proxy_image_requires_one_compatible_immutable_repo_digest() {
        let expected = format!("nc-fabric@sha256:{}", "a".repeat(64));
        assert_eq!(
            local_image_digest(&image(vec![expected.clone()]), &engine("aarch64")).unwrap(),
            expected
        );
        for digests in [
            vec![],
            vec![format!("nc-fabric:ollama-proxy@sha256:{}", "a".repeat(64))],
            vec![
                format!("nc-fabric@sha256:{}", "a".repeat(64)),
                format!("nc-fabric@sha256:{}", "c".repeat(64)),
            ],
        ] {
            assert!(local_image_digest(&image(digests), &engine("arm64")).is_err());
        }
        for (field, replacement) in [
            ("Architecture", json!("amd64")),
            ("Os", json!("windows")),
            ("Id", json!("mutable")),
            ("Config", json!({"Entrypoint":["sh"]})),
        ] {
            let mut value =
                serde_json::to_value(image(vec![format!("nc-fabric@sha256:{}", "a".repeat(64))]))
                    .unwrap();
            value[field] = replacement;
            assert!(
                local_image_digest(&serde_json::from_value(value).unwrap(), &engine("arm64"))
                    .is_err()
            );
        }
        assert!(
            local_image_digest(
                &image(vec![format!("nc-fabric@sha256:{}", "a".repeat(64))]),
                &engine("amd64")
            )
            .is_err()
        );
    }

    fn unresolved_document() -> Document {
        let mut value: serde_json::Value = serde_saphyr::from_str(include_str!(
            "../../../../tests/fixtures/config/managed-ollama.yaml"
        ))
        .unwrap();
        value["spec"]["inferenceProviders"][0]["serviceRef"] = json!("ollama-auth");
        value["spec"]["services"] = json!({"ollama-auth": {
            "kind":"ollamaProxy",
            "endpoint":"http://host.openshell.internal:11435/v1",
            "upstream":{"endpoint":"http://127.0.0.1:11434/v1",
                "model":{"name":"qwen3:0.6b","digest":"a".repeat(64)}}
        }});
        Document::parse(value.to_string().as_bytes()).unwrap()
    }

    #[tokio::test]
    async fn omitted_image_resolves_only_the_repository_owned_local_build() {
        let expected = format!("nc-fabric@sha256:{}", "a".repeat(64));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let inspected = image(vec![expected.clone()]);
        let fixture = Fixture::start(move |request| {
            observed
                .lock()
                .unwrap()
                .push((request.method.clone(), request.path.clone()));
            assert_eq!(request.method, "GET");
            let value = if request.path == "/info" {
                json!({"ID":"daemon", "OSType":"linux", "Architecture":"aarch64"})
            } else if request.path.starts_with("/images/") {
                serde_json::to_value(&inspected).unwrap()
            } else {
                panic!("unexpected image resolution request {}", request.path)
            };
            Some((200, serde_json::to_vec(&value).unwrap()))
        })
        .await;
        let logical = unresolved_document().spec.gateway.engine.clone();
        let connections =
            crate::docker::Connections::fixed([fixture.engine_for(&logical)]).unwrap();
        let mut document = unresolved_document();
        resolve_images(&mut document, &connections).await.unwrap();
        let crate::services::ServiceDefinition::OllamaProxy(proxy) =
            &document.spec.services["ollama-auth"]
        else {
            panic!("expected proxy service")
        };
        assert_eq!(proxy.image, expected);
        assert_eq!(requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn omitted_image_fails_closed_when_the_local_build_is_absent() {
        let fixture = Fixture::start(|request| {
            assert_eq!(request.method, "GET");
            if request.path == "/info" {
                Some((
                    200,
                    serde_json::to_vec(
                        &json!({"ID":"daemon", "OSType":"linux", "Architecture":"arm64"}),
                    )
                    .unwrap(),
                ))
            } else {
                Some((404, b"{}".to_vec()))
            }
        })
        .await;
        let logical = unresolved_document().spec.gateway.engine.clone();
        let connections =
            crate::docker::Connections::fixed([fixture.engine_for(&logical)]).unwrap();
        assert!(
            resolve_images(&mut unresolved_document(), &connections)
                .await
                .is_err()
        );
    }
}
