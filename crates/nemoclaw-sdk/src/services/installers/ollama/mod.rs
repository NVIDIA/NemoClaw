// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Ollama installer implementation.
mod config;
pub use config::{
    ExternalOllama, ExternalOllamaModel, ManagedOllama, OllamaMemory, OllamaModel, OllamaProxy,
    OllamaServing,
};
mod models;
pub use models::*;
mod artifacts;
pub(crate) mod capacity;
#[doc(hidden)]
pub mod hardware_capacity;
#[doc(hidden)]
pub mod model_source;
#[doc(hidden)]
pub mod policy;
mod registry;
mod service;
pub use service::{ProxySettings, ServiceSpec};
mod backend;
pub(crate) mod proxy;
pub use backend::OllamaBackend;

use crate::managed::{Process, Spec, Storage};
use crate::{
    Error,
    backend::Backend,
    compile::{Generations, Target},
    config::Document,
    services::contract::{InstallPlan, Installer, RemovePlan, validate_runtime},
    state::StateBinding,
};
use std::{collections::BTreeMap, net::IpAddr, sync::LazyLock, time::Duration};
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
    service["required"] = serde_json::json!(["kind", "hardware", "runtime", "model"]);
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
    for (name, field, minimum, maximum, default) in [
        ("OllamaServing", "port", 1024, 65535, 18888),
        ("OllamaServing", "contextTokens", 8192, 65536, 32768),
        ("OllamaServing", "maxSequences", 1, 2, 1),
        ("OllamaServing", "startupTimeoutSeconds", 60, 3600, 1800),
        ("OllamaMemory", "gpuMemoryGiB", 0, 96, 0),
        ("OllamaMemory", "hostReserveGiB", 28, 64, 32),
        ("OllamaMemory", "minAvailableGiB", 6, 16, 8),
        ("OllamaMemory", "minFreeGiB", 2, 8, 3),
        ("OllamaMemory", "freeGateGiB", 6, 24, 12),
        ("OllamaMemory", "consecutiveSamples", 1, 5, 5),
    ] {
        crate::config::schema::validation::property(
            &mut defs[name],
            field,
            serde_json::json!({
                "anyOf":[{"const":0},{"minimum":minimum,"maximum":maximum}],
                "default":default,
                "x-nemoclaw-default-rule":"Omitted or zero selects the default."
            }),
        );
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
        validate_runtime(&self.runtime)?;
        require(
            self.placement.is_some() == self.publication.is_some(),
            "Ollama placement and publication must be declared together",
        )?;
        if let (Some(placement), Some(publication)) = (&self.placement, &self.publication) {
            require(
                self.runtime.engine.starts_with("ssh://"),
                "explicit Ollama placement requires SSH Docker",
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
        } else {
            require(
                self.runtime.engine.starts_with("unix:///"),
                "local Ollama requires a Unix Docker socket",
            )?;
        }
        let hardware = self
            .hardware
            .as_ref()
            .ok_or_else(|| crate::config::ConfigError::new("Ollama requires explicit hardware"))?;
        let architecture = hardware.architecture()?;
        if let super::vllm::ServiceHardware::Profile {
            profile,
            min_gpu_memory_bytes,
            ..
        } = hardware
        {
            require(
                min_gpu_memory_bytes.is_none_or(|bytes| {
                    profile.memory_architecture() != super::vllm::MemoryArchitecture::Unified
                        && (4 * (1 << 30)..=4 * (1 << 40)).contains(&bytes)
                }),
                "profile minimum GPU memory requires dedicated memory and 4 GiB through 4 TiB",
            )?;
            require(
                self.memory.gpu_memory_utilization.is_none() || min_gpu_memory_bytes.is_some(),
                "GPU utilization requires explicit minGpuMemoryBytes",
            )?;
        }
        if let super::vllm::ServiceHardware::Dedicated(hardware) = hardware {
            require(
                architecture == "amd64"
                    && (10..=999).contains(&hardware.min_compute_capability)
                    && (4 * (1 << 30)..=4 * (1 << 40)).contains(&hardware.min_gpu_memory_bytes)
                    && (1..=9999).contains(&hardware.min_driver_major),
                "dedicated GPU requirements are invalid",
            )?;
        }
        let memory = &self.memory;
        let utilization_valid = memory
            .gpu_memory_utilization
            .as_ref()
            .and_then(serde_json::Number::as_f64)
            .is_none_or(|ratio| {
                self.dedicated_hardware().is_some()
                    && memory.gpu_memory_gib == 0
                    && (0.05..=0.95).contains(&ratio)
            });
        require(
            OLLAMA_MODEL.is_match(&self.model.name)
                && regex::Regex::new("^[a-f0-9]{64}$")
                    .unwrap()
                    .is_match(&self.model.digest)
                && (1024..=65535).contains(&self.serving.port)
                && (8192..=65536).contains(&self.serving.context_tokens)
                && (1..=2).contains(&self.serving.max_sequences)
                && (60..=3600).contains(&self.serving.startup_timeout_seconds)
                && (0..=96).contains(&memory.gpu_memory_gib)
                && (28..=64).contains(&memory.host_reserve_gib)
                && (6..=16).contains(&memory.min_available_gib)
                && (2..=8).contains(&memory.min_free_gib)
                && (6..=24).contains(&memory.free_gate_gib)
                && memory.free_gate_gib >= memory.min_available_gib
                && (1..=5).contains(&memory.consecutive_samples)
                && utilization_valid
                && self
                    .container
                    .as_ref()
                    .is_none_or(|container| (1..=64).contains(&container.shared_memory_gi_b)),
            "Ollama model, serving, hardware, or memory settings are invalid",
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
    Ok(service)
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
    let runtime = crate::services::ServiceDefinition::Ollama(service.runtime_settings());
    let network_cidr = service
        .placement
        .as_ref()
        .map_or(document.spec.gateway.network_cidr.clone(), |placement| {
            placement.network_cidr.clone()
        });
    let bind_address = service.publication.as_ref().map_or_else(
        || document.spec.gateway.bridge(),
        |publication| Ok(publication.bind_address.clone()),
    )?;
    let process = Process {
        engine: service.runtime.engine.clone(),
        image: service.runtime.image.clone(),
        network_cidr,
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
        compute_driver: service.runtime.provider.clone(),
        kind: SERVICE_KIND.into(),
        name: format!("{}-ollama-{name}", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation.clone(),
        gateway: if service.placement.is_some() {
            Default::default()
        } else {
            document.spec.gateway.runtime_settings()
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
            && let Some(policy) = service.runtime.image_pull_policy
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

async fn check_targets(
    targets: Vec<Target>,
    connections: &crate::docker::Connections,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<(), Error> {
    let check = async {
        for target in targets {
            let mut row = target.values;
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
        let service = address(SERVICE_KIND, name);
        let mut dependencies = vec![address(STORAGE_KIND, name)];
        if document.spec.gateway.management == "managed" && self.placement.is_none() {
            dependencies.insert(0, "nemoclaw_managed_gateway.runtime".into());
        }
        Ok(InstallPlan {
            targets: managed_targets(document, name, self, generations)?,
            dependencies: BTreeMap::from([(service, dependencies)]),
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
        let target = self
            .install(document, name, generations)?
            .targets
            .into_iter()
            .find(|target| target.kind == SERVICE_KIND)
            .ok_or(Error::State("Ollama install plan is incomplete"))?;
        let spec: Spec = serde_json::from_str(&target.values["spec"])
            .map_err(|_| Error::State("invalid Ollama runtime specification"))?;
        let binding = bindings
            .get(&target.address)
            .ok_or(Error::State("Ollama has no established identity"))?;
        let engine = crate::managed::runtime_engine(connections, &target.kind, &target.values)?;
        let check = async {
            loop {
                let observed = engine
                    .observe_runtime(&spec, &binding.id)
                    .await?
                    .ok_or(Error::State("Ollama runtime is unobservable"))?;
                if !observed.running {
                    return Err(Error::State(
                        "Ollama stopped during readiness; inspect logs and explicitly reapply",
                    ));
                }
                let status = artifacts::runtime_status(&engine, &observed).await?;
                if status.phase == "ready" {
                    artifacts::verify(&engine, &observed).await?;
                    return Ok(());
                }
                if status.phase == "stopped" {
                    return Err(Error::State(
                        "Ollama protection stopped the service; explicit reapply is required",
                    ));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        };
        tokio::select! {
            () = cancel.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout(Duration::from_secs(9 * 3600), check) => {
                result.map_err(|_| Error::State("Ollama readiness check timed out"))?
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
            retained: vec![address(STORAGE_KIND, name)],
            required_storage: vec![(address(SERVICE_KIND, name), address(STORAGE_KIND, name))],
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
