// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Ollama installer implementation.
mod config;
pub use config::{ExternalOllama, ExternalOllamaModel, ManagedOllama, OllamaModel, OllamaProxy};
mod models;
pub use models::*;
mod service;
pub use service::{ProxySettings, ServiceSpec};
mod backend;
pub(crate) mod proxy;
pub use backend::OllamaBackend;

use crate::{
    Error,
    backend::Backend,
    compile::{Generations, Target},
    config::Document,
    services::contract::{InstallPlan, Installer, RemovePlan, validate_runtime},
    state::StateBinding,
};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    sync::LazyLock,
};
use url::Url;

pub(crate) const MODEL_PATTERN: &str = r"^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$";
static OLLAMA_MODEL: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(MODEL_PATTERN).unwrap());

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, serde_json::Value>) {
    for name in ["OllamaModel", "ExternalOllamaModel"] {
        crate::config::schema::validation::property(
            &mut defs[name],
            "name",
            serde_json::json!({"pattern": MODEL_PATTERN}),
        );
    }
}

fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}

impl ManagedOllama {
    pub(crate) fn validate(&self) -> Result<(), crate::config::ConfigError> {
        use crate::config::validation::{SLUG, require};
        validate_runtime(&self.runtime)?;
        let url = Url::parse(&self.endpoint)
            .map_err(|_| crate::config::ConfigError::new("invalid Ollama endpoint"))?;
        let authority = self
            .endpoint
            .strip_prefix("http://")
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        let bind = authority.parse::<SocketAddr>().ok();
        require(
            self.runtime.engine.starts_with("unix:///")
                && self.runtime.image.starts_with("ollama/ollama@sha256:")
                && url.scheme() == "http"
                && url.path() == "/v1"
                && bind.is_some_and(|address| {
                    address.port() != 0 && (address.ip().is_loopback() || private(address.ip()))
                })
                && SLUG.is_match(self.network.name())
                && OLLAMA_MODEL.is_match(&self.model.name),
            "Ollama requires a local Unix Docker socket, pinned ollama/ollama image, existing network, private endpoint, and explicit model tag",
        )
    }
}

impl OllamaProxy {
    pub(crate) fn validate_definition(&self) -> Result<(), crate::config::ConfigError> {
        use crate::config::validation::require;
        validate_runtime(&self.runtime)?;
        crate::config::validate_endpoint(&self.endpoint, false)?;
        crate::config::validate_endpoint(&self.upstream.endpoint, false)?;
        let upstream = Url::parse(&self.upstream.endpoint)
            .map_err(|_| crate::config::ConfigError::new("invalid Ollama upstream"))?;
        let endpoint = Url::parse(&self.endpoint)
            .map_err(|_| crate::config::ConfigError::new("invalid proxy endpoint"))?;
        require(
            self.runtime.engine.starts_with("unix:///")
                && upstream.scheme() == "http"
                && upstream.path() == "/v1"
                && upstream.port().is_some()
                && upstream.host().is_some_and(|host| match host {
                    url::Host::Ipv4(ip) => ip.is_loopback(),
                    url::Host::Ipv6(ip) => ip.is_loopback(),
                    _ => false,
                })
                && endpoint.scheme() == "http"
                && endpoint.path() == "/v1"
                && endpoint.port().is_some()
                && matches!(endpoint.host(), Some(url::Host::Ipv4(_)))
                && self.endpoint != self.upstream.endpoint
                && OLLAMA_MODEL.is_match(&self.upstream.model.name)
                && regex::Regex::new("^[a-f0-9]{64}$")
                    .unwrap()
                    .is_match(&self.upstream.model.digest),
            "Ollama proxy requires a local external daemon, pinned installed model, private endpoint, and local Docker runner",
        )
    }
}

fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.{name}")
}

fn managed_specification(
    document: &Document,
    service: &ManagedOllama,
    generations: &Generations,
) -> Result<ServiceSpec, Error> {
    let spec = ServiceSpec {
        proxy: None,
        name: format!("{}-ollama", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generations
            .get("ollama")
            .filter(|value| !value.is_empty())
            .ok_or(Error::State("missing Ollama generation"))?
            .clone(),
        image: service.runtime.image.clone(),
        image_pull_policy: service.runtime.image_pull_policy,
        network: service.network.name().into(),
        bind_address: service
            .endpoint
            .strip_prefix("http://")
            .and_then(|value| value.strip_suffix("/v1"))
            .ok_or(Error::Conflict("invalid Ollama endpoint"))?
            .into(),
    };
    spec.validate()?;
    Ok(spec)
}

fn managed_targets(
    document: &Document,
    name: &str,
    service: &ManagedOllama,
    generations: &Generations,
) -> Result<Vec<Target>, Error> {
    let spec = managed_specification(document, service, generations)?;
    let mut common = crate::backend::Row::from([
        ("name".into(), spec.name),
        ("owner".into(), spec.owner),
        ("generation".into(), spec.generation),
        ("engine".into(), service.runtime.engine.clone()),
        ("image".into(), spec.image),
        ("network".into(), spec.network),
        ("bind_address".into(), spec.bind_address),
    ]);
    if let Some(policy) = spec.image_pull_policy {
        common.insert("image_pull_policy".into(), policy.as_str().into());
    }
    let mut running = common.clone();
    running.insert("running".into(), "true".into());
    Ok(vec![
        Target {
            kind: "ollama_storage".into(),
            address: address("ollama_storage", name),
            values: common,
        },
        Target {
            kind: "ollama".into(),
            address: address("ollama", name),
            values: running,
        },
        Target {
            kind: "ollama_model".into(),
            address: address("ollama_model", name),
            values: crate::backend::Row::from([
                ("engine".into(), service.runtime.engine.clone()),
                (
                    "service_id".into(),
                    format!("${{nemoclaw_ollama.{name}.id}}"),
                ),
                ("endpoint".into(), service.endpoint.clone()),
                ("model".into(), service.model.name.clone()),
            ]),
        },
    ])
}

async fn check_targets(
    targets: Vec<Target>,
    connections: &crate::docker::Connections,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    let check = async {
        for target in targets {
            let mut row = target.values;
            if target.kind == "ollama_model" {
                let logical = target
                    .address
                    .split_once('.')
                    .ok_or(Error::State("invalid service resource address"))?
                    .1;
                row.insert(
                    "service_id".into(),
                    bindings
                        .get(&address("ollama", logical))
                        .ok_or(Error::State("service has no established identity"))?
                        .id
                        .clone(),
                );
            }
            row.insert(
                "id".into(),
                bindings
                    .get(&target.address)
                    .ok_or(Error::State("service has no established identity"))?
                    .id
                    .clone(),
            );
            let backend = crate::services::BackendRegistry::new(connections)
                .resolve(&target.kind, &row)?
                .ok_or(Error::State("service backend is unavailable"))?;
            backend
                .read(&target.kind, &row, false)
                .await?
                .ok_or(Error::State("installed service is absent"))?;
        }
        Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(30), check)
        .await
        .map_err(|_| Error::State("service readiness check timed out"))?
}

impl Installer for ManagedOllama {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let service = address("ollama", name);
        Ok(InstallPlan {
            targets: managed_targets(document, name, self, generations)?,
            dependencies: BTreeMap::from([(service, vec![address("ollama_storage", name)])]),
        })
    }

    async fn check_running(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
        connections: &crate::docker::Connections,
        bindings: &BTreeMap<String, StateBinding>,
        cancel: &crate::CancellationToken,
    ) -> Result<(), Error> {
        let plan = self.install(document, name, generations)?;
        tokio::select! {
            () = cancel.cancelled() => Err(Error::Cancelled),
            result = check_targets(plan.targets, connections, bindings) => {
                result?;
                Ok(())
            }
        }
    }

    fn remove(
        &self,
        _document: &Document,
        name: &str,
        _generations: &Generations,
    ) -> Result<RemovePlan, Error> {
        Ok(RemovePlan {
            retained: vec![address("ollama_storage", name)],
            required_storage: vec![(address("ollama", name), address("ollama_storage", name))],
        })
    }
}

impl Installer for OllamaProxy {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let service = address(proxy::PROXY, name);
        Ok(InstallPlan {
            targets: proxy::targets(document, name, self, generations)?,
            dependencies: BTreeMap::from([(
                service,
                vec![address(proxy::STORAGE, name), address(proxy::MODEL, name)],
            )]),
        })
    }

    async fn check_running(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
        connections: &crate::docker::Connections,
        bindings: &BTreeMap<String, StateBinding>,
        cancel: &crate::CancellationToken,
    ) -> Result<(), Error> {
        let plan = self.install(document, name, generations)?;
        tokio::select! {
            () = cancel.cancelled() => Err(Error::Cancelled),
            result = check_targets(plan.targets, connections, bindings) => {
                result?;
                Ok(())
            }
        }
    }

    fn remove(
        &self,
        _document: &Document,
        name: &str,
        _generations: &Generations,
    ) -> Result<RemovePlan, Error> {
        Ok(RemovePlan {
            retained: vec![address(proxy::STORAGE, name)],
            required_storage: Vec::new(),
        })
    }
}

impl OllamaProxy {
    pub(crate) fn credential_source(
        &self,
        document: &Document,
        generations: &Generations,
    ) -> Result<String, Error> {
        let mut spec = proxy::specification(document, self, generations)?;
        spec.image_pull_policy = None;
        Ok(crate::services::authentication::Source::OllamaProxy {
            engine: self.runtime.engine.clone(),
            spec: Box::new(spec),
        }
        .json()?)
    }
}
