// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Ollama installer implementation.
use super::container::base;
mod config;
pub use config::{
    ExternalOllama, ExternalOllamaModel, ManagedOllama, OllamaMemory, OllamaModel, OllamaProxy,
    OllamaServing,
};
mod proxy_container;
pub use proxy_container::{ProxySettings, ProxySpec};
pub mod proxy;

use crate::managed::{Process, Spec};
use crate::{
    Error,
    compile::Generations,
    config::Document,
    services::contract::{InstallPlan, Installer, RemovePlan},
};
use std::collections::BTreeMap;
use url::Url;

pub const MODEL_PATTERN: &str = r"^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$";

pub(crate) fn constrain_schema(
    defs: &mut serde_json::Map<String, serde_json::Value>,
    normalized: bool,
) {
    nemoclaw_runtime::ollama::constrain_schema(defs, normalized);
    crate::config::schema::validation::property(
        &mut defs["ExternalOllamaModel"],
        "name",
        serde_json::json!({"pattern":MODEL_PATTERN}),
    );
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "ollama")
        .unwrap();
    service["required"] = serde_json::json!(["kind", "hardware", "image", "model"]);
    crate::config::schema::validation::property(
        service,
        "image",
        serde_json::json!({"pattern":crate::config::constraints::IMAGE}),
    );
    service["dependentRequired"] =
        serde_json::json!({"placement":["publication"],"publication":["placement"]});
    let proxy = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .expect("tagged service variants")
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "ollamaProxy")
        .expect("Ollama proxy service variant");
    crate::config::schema::validation::property(
        proxy,
        "image",
        serde_json::json!({"pattern":crate::config::constraints::IMAGE}),
    );
    crate::config::schema::validation::property(
        proxy,
        "engine",
        serde_json::json!({
            "x-nemoclaw-error": "proxy engine must be a local Unix socket"
        }),
    );
}

impl ManagedOllama {
    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        use crate::config::validation::require;
        crate::config::schema::validate_service("ollama", self)?;
        if let Some(placement) = self.published_placement()? {
            placement.validate(self.serving.port)?;
        }
        require(
            self.memory.free_gate_gib >= self.memory.min_available_gib,
            "memory free gate must be at least the available-memory threshold",
        )
    }
}

impl OllamaProxy {
    pub(crate) fn engine<'a>(
        &'a self,
        document: &'a Document,
    ) -> Result<&'a str, crate::config::ConfigError> {
        self.engine
            .as_deref()
            .map_or_else(|| Ok(document.spec.gateway.managed()?.engine.as_str()), Ok)
    }

    pub(crate) fn validate_definition(&self) -> Result<(), crate::config::ConfigError> {
        use crate::config::validation::require;
        crate::config::schema::validate_service("ollamaProxy", self)?;
        require(
            self.engine.as_ref().is_none_or(|engine| {
                engine.starts_with("unix:///")
                    && crate::config::validate_engine_endpoint(engine).is_ok()
            }),
            "proxy engine must be a local Unix socket",
        )?;
        // Sandboxes reach the proxy's endpoint, which OpenShell checks; the
        // proxy itself connects to its upstream.
        crate::config::validate_endpoint_url(&self.endpoint)?;
        crate::config::validate_endpoint(&self.upstream.endpoint, false)?;
        let upstream = Url::parse(&self.upstream.endpoint)
            .map_err(|_| crate::config::ConfigError::new("invalid Ollama upstream"))?;
        let endpoint = Url::parse(&self.endpoint)
            .map_err(|_| crate::config::ConfigError::new("invalid proxy endpoint"))?;
        require(
            upstream.scheme() == "http"
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
                && self.endpoint != self.upstream.endpoint,
            "Ollama proxy requires a local external daemon, pinned installed model, private endpoint, and local Docker runner",
        )
    }
}

/// The address of the service's model container resource.
pub(crate) fn service_address(name: &str) -> String {
    address(SERVICE_KIND, name)
}

fn address(kind: &str, name: &str) -> String {
    format!("{}.{name}", crate::compile::resource_type(kind))
}

pub const SERVICE_KIND: &str = "ollama_service";
/// Data source that computes the Ollama runtime contract.
pub const RUNTIME_DATA_SOURCE: &str = "ollama_runtime";

/// OpenTofu attributes for the Ollama runtime contract.
pub fn runtime_fields() -> Result<crate::hcl_schema::Fields, crate::hcl_schema::Unmappable> {
    let schema = schemars::schema_for!(nemoclaw_runtime::ollama::ManagedOllama).to_value();
    crate::hcl_schema::fields(&schema, &[])
}
pub const STORAGE_KIND: &str = "ollama_service_storage";

pub fn configured_service(spec: &Spec) -> Result<nemoclaw_runtime::ollama::ManagedOllama, Error> {
    match nemoclaw_runtime::RuntimeSpec::decode(spec.runtime_configuration()?)? {
        nemoclaw_runtime::RuntimeSpec::Ollama(service) => Ok(*service),
        _ => Err(Error::Conflict("runtime configuration is not Ollama")),
    }
}

fn specification(
    document: &Document,
    name: &str,
    service: &ManagedOllama,
    generations: &Generations,
) -> Result<Spec, Error> {
    let runtime = nemoclaw_runtime::RuntimeSpec::Ollama(Box::new(service.runtime_settings()));
    let placed = crate::services::placement::ResolvedPlacement::resolve(
        service.published_placement()?,
        &document.spec.gateway,
        service.serving.port,
    )?;
    let process = base::managed_process(
        runtime,
        service.container.as_ref(),
        Process {
            engine: placed.engine.clone(),
            image: service.image.clone(),
            network_cidr: placed.network_cidr.clone(),
            create_network: placed.explicit,
            architecture: service.architecture()?.into(),
            image_labels: BTreeMap::from([("org.nemoclaw.backend".into(), "ollama".into())]),

            bind_address: placed.bind_address,
            port: service.serving.port as u16,
            ..Process::default()
        },
    )?;
    base::specification(
        document,
        generations,
        SERVICE_KIND,
        format!("{}-ollama-{name}", document.workspace()),
        if placed.explicit {
            Default::default()
        } else {
            document.spec.gateway.managed()?.runtime_settings()
        },
        process,
    )
}

impl Installer for ManagedOllama {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let mut prerequisites = Vec::new();
        if document.spec.gateway.as_managed().is_some() && self.placement.is_none() {
            prerequisites.push("openshell_podman_gateway.runtime".into());
        }
        base::install(
            specification(document, name, self, generations)?,
            name,
            STORAGE_KIND,
            self.image_pull_policy,
            Default::default(),
            InstallPlan {
                targets: Vec::new(),
                dependencies: BTreeMap::from([(address(SERVICE_KIND, name), prerequisites)]),
            },
        )
    }

    fn remove(
        &self,
        _document: &Document,
        name: &str,
        _generations: &Generations,
    ) -> Result<RemovePlan, Error> {
        Ok(RemovePlan {
            retained: vec![crate::docker_compute::address(&address(STORAGE_KIND, name))],
            required_storage: Vec::new(),
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
            dependencies: BTreeMap::from([(service, vec![address(proxy::STORAGE, name)])]),
        })
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
        name: &str,
        generations: &Generations,
    ) -> Result<String, Error> {
        let spec = proxy::specification(document, name, self, generations)?;
        Ok(crate::services::authentication::source_json(
            &crate::services::authentication::Source::OllamaProxy {
                storage: crate::managed::Storage {
                    name: spec.volume(),
                    owner: spec.owner.clone(),
                    generation: spec.generation.clone(),
                    engine: self.engine(document)?.into(),
                },
                container: spec.name.clone(),
                endpoint: spec.settings.endpoint.clone(),
            },
        )?)
    }
}

impl ManagedOllama {
    /// Explicit placement and publication, or inheritance from the managed gateway.
    pub fn published_placement(
        &self,
    ) -> Result<
        Option<crate::services::placement::PublishedPlacement<'_>>,
        crate::config::ConfigError,
    > {
        crate::services::placement::PublishedPlacement::from_parts(
            self.placement.as_ref(),
            self.publication.as_ref(),
        )
    }
}
