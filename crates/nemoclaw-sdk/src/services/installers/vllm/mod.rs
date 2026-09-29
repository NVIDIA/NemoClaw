// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! vLLM installer launch behavior; model and hardware qualification belongs to recipes.
use crate::config::ComputeDriver;
mod config;
mod container;
mod hardware_profile;
mod service_hardware;
use crate::Error;
pub use crate::services::placement::{ServicePlacement, ServicePublication};
pub use config::{Memory, Model, Service, ServiceAuthentication, Serving};
pub use container::{ServiceContainer, ServiceIpc};
pub use hardware_profile::HardwareProfile;
#[cfg(test)]
use nemoclaw_runtime::vllm::arguments;
pub use service_hardware::{DedicatedHardware, ServiceHardware, VllmLaunchMode};
pub(crate) mod schema;
#[cfg(test)]
mod tests;

use crate::{
    compile::{Generations, Target},
    config::{ConfigError, Document},
    managed::{Process, Spec, Storage},
    services::contract::{InstallPlan, Installer, RemovePlan},
};
use std::collections::BTreeMap;

pub const SERVICE_KIND: &str = "inference_service";
pub const STORAGE_KIND: &str = "inference_storage";

pub fn configured_service(spec: &Spec) -> Result<nemoclaw_runtime::vllm::Service, Error> {
    let configuration = spec.runtime_configuration()?;
    match nemoclaw_runtime::RuntimeSpec::decode(configuration)? {
        nemoclaw_runtime::RuntimeSpec::Vllm(service) => Ok(*service),
        _ => Err(Error::Conflict("runtime configuration is not vLLM")),
    }
}

impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("vllm", self)?;
        if let Some(placement) = self.published_placement()? {
            placement.validate(self.serving.port)?;
        }
        self.runtime.validate()
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
    let runtime_service = service.runtime_settings();
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
    let placement = service.published_placement()?;
    let (engine, network_cidr, bind_address) = match placement {
        Some(explicit) => (
            &explicit.placement.engine,
            &explicit.placement.network_cidr,
            explicit.publication.bind_address.clone(),
        ),
        None => {
            let gateway = document.spec.gateway.managed()?;
            (&gateway.engine, &gateway.network_cidr, gateway.bridge()?)
        }
    };
    let architecture = service.architecture()?.to_owned();
    let process = Process {
        engine: engine.clone(),
        image: service.image.clone(),
        network_cidr: network_cidr.clone(),
        create_network: service.placement.is_some(),
        architecture,
        image_labels,
        pull_image: false,
        image_pull_policy: None,
        configuration: serde_json::to_string(&nemoclaw_runtime::RuntimeSpec::Vllm(Box::new(
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
            * nemoclaw_runtime::hardware::GIB,
        host_ipc: service
            .container
            .as_ref()
            .is_some_and(|container| container.ipc == ServiceIpc::Host),
        memory_bytes: 104 * nemoclaw_runtime::hardware::GIB,
        gpu: true,
    };
    let spec = Spec {
        layout: 0,
        compute_driver: ComputeDriver::Docker,
        kind: SERVICE_KIND.into(),
        name: format!("{}-inference-{name}", document.workspace()),
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
        if document.spec.gateway.as_managed().is_some() && self.placement.is_none() {
            service_dependencies.insert(0, "nemoclaw_managed_gateway.runtime".into());
        }
        Ok(InstallPlan {
            targets,
            dependencies: BTreeMap::from([(service, service_dependencies)]),
        })
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

impl Service {
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
