// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::OllamaProxy;
use super::*;
use crate::{
    Error,
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
        ("engine", proxy.engine(document)?.into()),
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
