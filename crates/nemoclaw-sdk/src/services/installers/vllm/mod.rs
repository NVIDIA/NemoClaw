// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! vLLM installer launch behavior; model and hardware qualification belongs to recipes.
mod config;
mod constraints;
mod hardware_profile;
#[cfg(target_os = "linux")]
pub(in crate::services) mod runtime;
mod service_hardware;
use crate::Error;
pub use config::{
    Memory, Model, Service, ServiceAuthentication, ServicePlacement, ServicePublication, Serving,
};
pub use hardware_profile::HardwareProfile;
pub(crate) use hardware_profile::MemoryArchitecture;
pub use service_hardware::{DedicatedHardware, ServiceContainer, ServiceHardware, ServiceIpc};
pub(crate) mod arguments;
pub(crate) mod artifacts;
pub use artifacts::RuntimeStatus;
pub(crate) mod capacity;
pub mod hardware_capacity;
mod hardware_policy;
pub(crate) mod policy;
pub mod recipes;
pub(crate) mod schema;
pub(crate) mod validation;
impl Service {
    pub fn gpu_bytes(&self) -> Result<u64, Error> {
        self.validate()?;
        Ok(validation::gpu_bytes(self))
    }
    pub fn check_capacity(
        &self,
        capacity: &crate::hardware::Capacity,
        starting: bool,
        download_remaining: u64,
        preparation_remaining: u64,
    ) -> Result<(), Error> {
        hardware_capacity::check_capacity(
            self,
            capacity,
            starting,
            download_remaining,
            preparation_remaining,
        )
    }
    pub fn arguments(&self, model_directory: &str, total: u64) -> Result<Vec<String>, Error> {
        self.validate()?;
        arguments::arguments(self, model_directory, total)
    }
}

#[cfg(test)]
mod tests;

use crate::{
    compile::{Generations, Target},
    config::{ConfigError, Document},
    managed::{Process, Spec, Storage},
    services::contract::{InstallPlan, Installer, RemovePlan, validate_image},
    state::StateBinding,
};
use std::{collections::BTreeMap, time::Duration};
use url::Url;

pub(crate) const SERVICE_KIND: &str = "inference_service";
pub(crate) const STORAGE_KIND: &str = "inference_storage";

pub(crate) fn configured_service(spec: &Spec) -> Result<Service, Error> {
    let configuration = spec
        .process
        .as_ref()
        .map(|process| process.configuration.as_str())
        .ok_or(Error::Conflict("vLLM runtime has no service configuration"))?;
    let service = match serde_json::from_str::<crate::services::ServiceDefinition>(configuration) {
        Ok(crate::services::ServiceDefinition::Vllm(service)) => *service,
        Ok(_) => return Err(Error::Conflict("runtime configuration is not vLLM")),
        Err(_) => serde_json::from_str::<Service>(configuration)
            .map_err(|_| Error::Conflict("vLLM runtime configuration is invalid"))?,
    };
    service.validate()?;
    Ok(service)
}

fn private(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => ip.is_private(),
        std::net::IpAddr::V6(ip) => ip.is_unique_local(),
    }
}

impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
        use crate::config::validation::require;
        validate_image(&self.image)?;
        crate::config::ImagePullPolicy::validate_service(self.image_pull_policy)?;
        require(
            self.placement.is_some() == self.publication.is_some(),
            "service placement and publication must be declared together",
        )?;
        if let (Some(placement), Some(publication)) = (&self.placement, &self.publication) {
            require(
                placement.engine.starts_with("ssh://"),
                "explicit service placement requires SSH Docker",
            )?;
            require(
                crate::docker::Engine::validate_endpoint(&placement.engine).is_ok(),
                "invalid service engine",
            )?;
            let network: ipnet::Ipv4Net = placement
                .network_cidr
                .parse()
                .map_err(|_| ConfigError::new("invalid service network"))?;
            require(
                network.prefix_len() == 24
                    && network.addr() == network.network()
                    && private(network.addr().into()),
                "service network requires a private IPv4 /24",
            )?;
            crate::config::validate_endpoint(&publication.endpoint, false)?;
            let endpoint = Url::parse(&publication.endpoint).unwrap();
            let address: std::net::Ipv4Addr = publication
                .bind_address
                .parse()
                .map_err(|_| ConfigError::new("invalid service bind address"))?;
            require(
                private(address.into())
                    && !address.is_loopback()
                    && !network.contains(&address)
                    && endpoint.scheme() == "http"
                    && endpoint.host_str() == Some(publication.bind_address.as_str())
                    && endpoint.port() == Some(self.serving.port as u16)
                    && endpoint.path() == "/v1",
                "service publication must match its private bind address, serving port and /v1 path",
            )?;
        }
        validation::validate(self)
    }
}

fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.inference_{name}")
}

fn targets(
    document: &Document,
    name: &str,
    service: &Service,
    generations: &Generations,
) -> Result<(Vec<Target>, Spec), Error> {
    let generation = generations
        .get(SERVICE_KIND)
        .filter(|value| !value.is_empty())
        .ok_or(crate::config::ConfigError::new(
            "missing resource generation",
        ))?;
    let mut runtime_service = service.runtime_settings();
    runtime_service.placement = None;
    runtime_service.publication = None;
    let mut image_labels = service
        .recipe
        .as_ref()
        .map(|recipe| recipe.compatibility.image_labels.clone())
        .unwrap_or_default();
    image_labels.insert("org.nemoclaw.backend".into(), "vllm".into());
    if service.authentication.is_some() {
        image_labels.insert(
            "org.nemoclaw.inference.authentication".into(),
            "bearer-v1".into(),
        );
    }
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
    let architecture = service.architecture()?.to_owned();
    let process = Process {
        engine: service
            .placement
            .as_ref()
            .map_or(document.spec.gateway.engine.clone(), |placement| {
                placement.engine.clone()
            }),
        image: service.image.clone(),
        network_cidr,
        create_network: service.placement.is_some(),
        architecture,
        image_labels,
        pull_image: false,
        image_pull_policy: None,
        configuration: serde_json::to_string(&crate::services::ServiceDefinition::Vllm(Box::new(
            runtime_service,
        )))
        .map_err(|_| Error::State("cannot serialize service runtime configuration"))?,
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
            .is_some_and(|container| container.ipc == ServiceIpc::Host),
        memory_bytes: 104 * crate::hardware::GIB,
        gpu: true,
    };
    let spec = Spec {
        layout: 0,
        compute_driver: "docker".into(),
        kind: SERVICE_KIND.into(),
        name: format!("{}-inference-{name}", document.workspace()),
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
        engine: spec.engine().to_owned(),
    };
    let mut result = Vec::new();
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
        result.push(Target {
            kind: kind.into(),
            address: address(kind, name),
            values,
        });
    }
    if service.authentication.is_some() {
        let mut credentials = storage.clone();
        credentials.name = format!("{}-auth", spec.name);
        result.push(Target {
            kind: STORAGE_KIND.into(),
            address: address(STORAGE_KIND, &format!("{name}_auth")),
            values: crate::backend::Row::from([("spec".into(), credentials.json()?)]),
        });
    }
    Ok((result, spec))
}

impl Installer for Service {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let (targets, _) = targets(document, name, self, generations)?;
        let service = address(SERVICE_KIND, name);
        let mut service_dependencies = vec![address(STORAGE_KIND, name)];
        if self.authentication.is_some() {
            service_dependencies.push(address(STORAGE_KIND, &format!("{name}_auth")));
        }
        if document.spec.gateway.management == "managed" && self.placement.is_none() {
            service_dependencies.insert(0, "nemoclaw_managed_gateway.runtime".into());
        }
        Ok(InstallPlan {
            targets,
            dependencies: BTreeMap::from([(service, service_dependencies)]),
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
        let target = plan
            .targets
            .iter()
            .find(|target| target.kind == SERVICE_KIND)
            .ok_or(Error::State("vLLM install plan is incomplete"))?;
        let spec: Spec = serde_json::from_str(&target.values["spec"])
            .map_err(|_| Error::State("invalid vLLM runtime specification"))?;
        let binding = bindings
            .get(&crate::docker_compute::address(&target.address))
            .ok_or(Error::State("vLLM has no established identity"))?;
        let engine = crate::managed::runtime_engine(connections, &target.kind, &target.values)?;
        let check = async {
            loop {
                let observed = engine
                    .observe_service(&spec, &binding.id)
                    .await?
                    .ok_or(Error::State("vLLM runtime is unobservable"))?;
                if !observed.running {
                    return Err(Error::State(
                        "vLLM stopped during its readiness check; inspect logs and explicitly reapply",
                    ));
                }
                let status = engine.runtime_status(&observed).await?;
                if status.phase == "ready" {
                    if self.authentication.is_some() {
                        crate::services::authentication::read_service_key(
                            &engine,
                            &observed.container_id,
                        )
                        .await?;
                    }
                    return Ok(());
                }
                if status.phase == "stopped" {
                    return Err(Error::State(
                        "vLLM protection stopped the service; explicit reapply is required",
                    ));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        };
        tokio::select! {
            () = cancel.cancelled() => Err(Error::Cancelled),
            result = tokio::time::timeout(Duration::from_secs(9 * 3600), check) => {
                result.map_err(|_| Error::State("vLLM readiness check timed out"))?
            }
        }
    }

    fn remove(
        &self,
        _document: &Document,
        name: &str,
        _generations: &Generations,
    ) -> Result<RemovePlan, Error> {
        let mut retained = vec![crate::docker_compute::address(&address(STORAGE_KIND, name))];
        if self.authentication.is_some() {
            retained.insert(0, address(STORAGE_KIND, &format!("{name}_auth")));
        }
        Ok(RemovePlan {
            required_storage: retained
                .iter()
                .filter(|storage| !storage.starts_with("docker_volume."))
                .map(|storage| (address(SERVICE_KIND, name), storage.clone()))
                .collect(),
            retained,
        })
    }
}

impl Service {
    pub(crate) fn credential_source(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<Option<String>, Error> {
        if self.authentication.is_none() {
            return Ok(None);
        }
        let (_, spec) = targets(document, name, self, generations)?;
        Ok(Some(
            crate::services::authentication::Source::ManagedService {
                storage: crate::managed::Storage {
                    name: format!("{}-auth", spec.name),
                    owner: spec.owner.clone(),
                    generation: spec.generation.clone(),
                    engine: spec.engine().into(),
                },
                container: spec.name.clone(),
                endpoint: {
                    let process = spec
                        .process
                        .as_ref()
                        .ok_or(Error::State("missing service process"))?;
                    format!("http://{}:{}/v1", process.bind_address, process.port)
                },
            }
            .json()?,
        ))
    }
}
