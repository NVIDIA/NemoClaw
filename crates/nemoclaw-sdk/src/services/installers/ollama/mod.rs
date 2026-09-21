// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Ollama installer implementation.
use crate::config::ComputeDriver;
mod config;
mod constraints;
#[cfg(target_os = "linux")]
pub(in crate::services) mod runtime;
pub use config::{
    ExternalOllama, ExternalOllamaModel, ManagedOllama, OllamaMemory, OllamaModel, OllamaProxy,
    OllamaServing,
};
mod models;
pub use models::*;
pub(in crate::services) mod artifacts;
#[doc(hidden)]
pub mod hardware_capacity;
#[doc(hidden)]
pub mod model_source;
#[doc(hidden)]
pub mod policy;
mod proxy_container;
mod registry;
pub use proxy_container::{ProxySettings, ProxySpec};
mod backend;
pub(crate) mod proxy;
pub use backend::ProxyBackend;

use crate::managed::{Process, Spec, Storage};
use crate::{
    Error,
    compile::{Generations, Target},
    config::Document,
    services::contract::{InstallPlan, Installer, RemovePlan},
};
use std::{collections::BTreeMap, net::IpAddr};
use url::Url;

pub(crate) const MODEL_PATTERN: &str = r"^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$";

pub(crate) fn constrain_schema(
    defs: &mut serde_json::Map<String, serde_json::Value>,
    normalized: bool,
) {
    for name in ["OllamaModel", "ExternalOllamaModel"] {
        crate::config::schema::validation::property(
            &mut defs[name],
            "name",
            serde_json::json!({"pattern": MODEL_PATTERN}),
        );
    }
    crate::config::schema::validation::property(
        &mut defs["OllamaModel"],
        "digest",
        serde_json::json!({"pattern":"^[a-f0-9]{64}$"}),
    );
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .expect("tagged service variants")
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "ollama")
        .expect("Ollama service variant");
    service["required"] = serde_json::json!(["kind", "hardware", "image", "model"]);
    crate::config::schema::validation::property(
        service,
        "image",
        serde_json::json!({"pattern":crate::config::constraints::IMAGE}),
    );
    service["dependentRequired"] =
        serde_json::json!({"placement":["publication"],"publication":["placement"]});
    service["allOf"] = serde_json::json!([
        {"if":crate::config::schema::validation::at("memory/gpuMemoryUtilization",serde_json::json!({}),true),
         "then":{"allOf":[
             crate::config::schema::validation::at("hardware/minGpuMemoryBytes",serde_json::json!({}),true),
             crate::config::schema::validation::at("hardware/profile",serde_json::json!({"not":{"enum":super::vllm::HardwareProfile::UNIFIED_MEMORY}}),false),
             crate::config::schema::validation::at("memory/gpuMemoryGiB",serde_json::json!({"const":0}),false)
         ]}}
    ]);
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
    for (name, field, rule) in [
        ("OllamaServing", "port", &constraints::PORT),
        (
            "OllamaServing",
            "contextTokens",
            &constraints::CONTEXT_TOKENS,
        ),
        ("OllamaServing", "maxSequences", &constraints::MAX_SEQUENCES),
        (
            "OllamaServing",
            "startupTimeoutSeconds",
            &constraints::STARTUP_TIMEOUT,
        ),
        ("OllamaMemory", "gpuMemoryGiB", &constraints::GPU_MEMORY),
        ("OllamaMemory", "hostReserveGiB", &constraints::HOST_RESERVE),
        (
            "OllamaMemory",
            "minAvailableGiB",
            &constraints::MIN_AVAILABLE,
        ),
        ("OllamaMemory", "minFreeGiB", &constraints::MIN_FREE),
        ("OllamaMemory", "freeGateGiB", &constraints::FREE_GATE),
        (
            "OllamaMemory",
            "consecutiveSamples",
            &constraints::CONSECUTIVE_SAMPLES,
        ),
    ] {
        crate::config::schema::validation::integer(&mut defs[name], field, rule, normalized);
    }
    crate::config::schema::validation::property(
        &mut defs["OllamaMemory"],
        "gpuMemoryGiB",
        serde_json::json!({
            "x-nemoclaw-default-rule":"Omitted or zero stays zero in the document. Without gpuMemoryUtilization, the installer uses 16 GiB."
        }),
    );
    crate::config::schema::validation::property(
        &mut defs["OllamaMemory"],
        "gpuMemoryUtilization",
        serde_json::json!({"minimum":0.05,"maximum":0.95}),
    );
}

fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}

impl ManagedOllama {
    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        use crate::config::validation::require;
        crate::config::schema::validate_service("ollama", self)?;
        if let (Some(placement), Some(publication)) = (&self.placement, &self.publication) {
            require(
                placement.engine.starts_with("ssh://"),
                "explicit Ollama placement requires SSH Docker",
            )?;
            require(
                crate::docker::Engine::validate_endpoint(&placement.engine).is_ok(),
                "invalid Ollama engine",
            )?;
            let network: ipnet::Ipv4Net = placement
                .network_cidr
                .parse()
                .map_err(|_| crate::config::ConfigError::new("invalid Ollama network"))?;
            crate::config::validate_endpoint(&publication.endpoint, false)?;
            let endpoint = Url::parse(&publication.endpoint)
                .map_err(|_| crate::config::ConfigError::new("invalid Ollama publication"))?;
            let address: std::net::Ipv4Addr = publication
                .bind_address
                .parse()
                .map_err(|_| crate::config::ConfigError::new("invalid Ollama bind address"))?;
            require(
                network.prefix_len() == 24
                    && network.addr() == network.network()
                    && private(network.addr().into())
                    && private(address.into())
                    && !address.is_loopback()
                    && !network.contains(&address)
                    && endpoint.scheme() == "http"
                    && endpoint.host_str() == Some(publication.bind_address.as_str())
                    && endpoint.port() == Some(self.serving.port as u16)
                    && endpoint.path() == "/v1",
                "Ollama publication must match its private bind address, serving port and /v1 path",
            )?;
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
                    && crate::docker::Engine::validate_endpoint(engine).is_ok()
            }),
            "proxy engine must be a local Unix socket",
        )?;
        crate::config::validate_endpoint(&self.endpoint, false)?;
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

fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.{name}")
}

pub(crate) const SERVICE_KIND: &str = "ollama_service";
pub(crate) const STORAGE_KIND: &str = "ollama_service_storage";

pub(crate) fn configured_service(spec: &Spec) -> Result<ManagedOllama, Error> {
    let configuration = spec.runtime_configuration()?;
    let definition: crate::services::ServiceDefinition = serde_json::from_str(configuration)
        .map_err(|_| Error::Conflict("Ollama runtime configuration is invalid"))?;
    let crate::services::ServiceDefinition::Ollama(service) = definition else {
        return Err(Error::Conflict("runtime configuration is not Ollama"));
    };
    service.validate()?;
    Ok(*service)
}

fn managed_targets(
    document: &Document,
    name: &str,
    service: &ManagedOllama,
    generations: &Generations,
) -> Result<Vec<Target>, Error> {
    let generation = generations
        .get(SERVICE_KIND)
        .filter(|value| !value.is_empty())
        .ok_or(Error::State("missing Ollama service generation"))?;
    let runtime = crate::services::ServiceDefinition::Ollama(Box::new(service.runtime_settings()));
    let (engine, network_cidr) = match &service.placement {
        Some(placement) => (&placement.engine, &placement.network_cidr),
        None => {
            let gateway = document.spec.gateway.managed()?;
            (&gateway.engine, &gateway.network_cidr)
        }
    };
    let bind_address = service.publication.as_ref().map_or_else(
        || document.spec.gateway.managed()?.bridge(),
        |publication| Ok(publication.bind_address.clone()),
    )?;
    let process = Process {
        engine: engine.clone(),
        image: service.image.clone(),
        network_cidr: network_cidr.clone(),
        create_network: service.placement.is_some(),
        architecture: service.architecture()?.into(),
        image_labels: BTreeMap::from([("org.nemoclaw.backend".into(), "ollama".into())]),
        pull_image: false,
        image_pull_policy: None,
        configuration: serde_json::to_string(&runtime)
            .map_err(|_| Error::State("cannot serialize Ollama runtime configuration"))?,
        entrypoint: vec!["/usr/local/bin/nemoclaw-runtime".into()],
        command: Vec::new(),
        mount_target: "/data".into(),
        bind_address,
        port: service.serving.port as u16,
        shared_memory_bytes: service
            .container
            .as_ref()
            .map_or(8, |container| container.shared_memory_gi_b)
            * crate::hardware::GIB,
        host_ipc: service
            .container
            .as_ref()
            .is_some_and(|container| container.ipc == super::vllm::ServiceIpc::Host),
        memory_bytes: 104 * crate::hardware::GIB,
        gpu: true,
    };
    let spec = Spec {
        layout: 0,
        compute_driver: ComputeDriver::Docker,
        kind: SERVICE_KIND.into(),
        name: format!("{}-ollama-{name}", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation.clone(),
        gateway: if service.placement.is_some() {
            Default::default()
        } else {
            document.spec.gateway.managed()?.runtime_settings()
        },
        process: Some(process),
    };
    let storage = Storage {
        name: format!("{}-data", spec.name),
        owner: spec.owner.clone(),
        generation: spec.generation.clone(),
        engine: spec.engine().into(),
    };
    let mut targets = Vec::new();
    for (kind, encoded) in [
        (STORAGE_KIND, storage.json()?),
        (SERVICE_KIND, spec.json()?),
    ] {
        let mut values = crate::backend::Row::from([("spec".into(), encoded)]);
        if kind == SERVICE_KIND
            && let Some(policy) = service.image_pull_policy
        {
            values.insert("image_pull_policy".into(), policy.as_str().into());
        }
        targets.push(Target {
            kind: kind.into(),
            address: address(kind, name),
            values,
        });
    }
    Ok(targets)
}

impl Installer for ManagedOllama {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let service = address(SERVICE_KIND, name);
        let mut dependencies = vec![address(STORAGE_KIND, name)];
        if document.spec.gateway.as_managed().is_some() && self.placement.is_none() {
            dependencies.insert(0, "nemoclaw_managed_gateway.runtime".into());
        }
        Ok(InstallPlan {
            targets: managed_targets(document, name, self, generations)?,
            dependencies: BTreeMap::from([(service, dependencies)]),
        })
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
            dependencies: BTreeMap::from([(
                service,
                vec![address(proxy::STORAGE, name), address(proxy::MODEL, name)],
            )]),
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
        Ok(crate::services::authentication::Source::OllamaProxy {
            storage: crate::managed::Storage {
                name: spec.volume(),
                owner: spec.owner.clone(),
                generation: spec.generation.clone(),
                engine: self.engine(document)?.into(),
            },
            container: spec.name.clone(),
            endpoint: spec.settings.endpoint.clone(),
        }
        .json()?)
    }
}
