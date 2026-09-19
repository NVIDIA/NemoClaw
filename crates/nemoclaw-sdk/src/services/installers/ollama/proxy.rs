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
pub const PROXY: &str = "ollama_proxy";
pub const STORAGE: &str = "ollama_proxy_storage";
pub const MODEL: &str = "ollama_external_model";
pub fn supports(kind: &str) -> bool {
    matches!(kind, PROXY | STORAGE | MODEL)
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
        bind_address: proxy
            .endpoint
            .strip_prefix("http://")
            .and_then(|s| s.strip_suffix("/v1"))
            .ok_or(Error::State("invalid proxy endpoint"))?
            .into(),
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
            endpoint: format!("http://{binding}/v1"),
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
        ("engine", document.spec.gateway.engine.clone()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v))
    .collect();
    if let Some(policy) = spec.image_pull_policy {
        common.insert("image_pull_policy".into(), policy.as_str().into());
    }
    Ok([STORAGE, PROXY, MODEL]
        .into_iter()
        .map(|kind| {
            let mut values = common.clone();
            if kind == PROXY {
                values.insert("running".into(), "true".into());
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
        let spec = row_spec(row)?;
        let id = row.get("id").map(String::as_str).unwrap_or("");
        let mut result = row.clone();
        if kind == MODEL {
            if !removing {
                verify_model(&spec.settings).await?;
            }
            let expected = format!(
                "{}/{}/{}",
                spec.owner, spec.generation, spec.settings.digest
            );
            if !id.is_empty() && id != expected {
                return Err(ObservationError::BindingMismatch.into());
            }
            result.insert("id".into(), expected);
            return Ok(Some(result));
        }
        if kind == STORAGE {
            let observed = if apply {
                Some(self.engine.ensure_ollama_proxy_storage(&spec, id).await?)
            } else {
                self.engine.observe_ollama_proxy_storage(&spec, id).await?
            };
            return Ok(observed.map(|id| {
                result.insert("id".into(), id);
                result
            }));
        }
        if kind != PROXY {
            return Err(ObservationError::Query.into());
        }
        let service = if removing {
            self.engine.observe_ollama_proxy_removal(&spec, id).await?
        } else if apply {
            verify_model(&spec.settings).await?;
            Some(self.engine.ensure_ollama_proxy(&spec, id).await?)
        } else {
            match self.engine.observe_ollama_proxy(&spec, id).await {
                Err(Error::PartialRuntime) if id.is_empty() => None,
                other => other?,
            }
        };
        if let Some(service) = &service
            && service.running
            && !removing
        {
            let container = service
                .id
                .split('/')
                .nth(1)
                .ok_or(Error::State("invalid proxy identity"))?;
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(if apply { 30 } else { 0 });
            loop {
                match crate::services::authentication::read_key(&self.engine, container).await {
                    Ok(_) => break,
                    Err(_) if apply && std::time::Instant::now() < deadline => {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(service.map(|service| {
            result.insert("id".into(), service.id);
            result.insert("running".into(), service.running.to_string());
            result
        }))
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
        let spec = row_spec(row)?;
        let id = row
            .get("id")
            .filter(|s| !s.is_empty())
            .ok_or(Error::State("missing proxy identity"))?;
        self.engine.remove_ollama_proxy(&spec, id).await
    }
}
