// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Compose native NIM storage and supervised inference through Docker.
mod config;
use super::{
    container::base,
    vllm::{SERVICE_KIND, STORAGE_KIND},
};
use crate::{
    Error,
    compile::Generations,
    config::{ConfigError, Document},
    managed::{Process, Spec},
    services::{
        contract::{InstallPlan, Installer, RemovePlan},
        placement::{PublishedPlacement, ResolvedPlacement},
    },
};
pub use config::{NgcCredential, Nim as Service};

pub const RUNTIME_DATA_SOURCE: &str = "nim_runtime";
pub fn runtime_fields() -> Result<crate::hcl_schema::Fields, crate::hcl_schema::Unmappable> {
    crate::hcl_schema::fields(
        &schemars::schema_for!(nemoclaw_runtime::nim::NimService).to_value(),
        &[],
    )
}
pub fn configured_service(spec: &Spec) -> Result<nemoclaw_runtime::nim::NimService, Error> {
    match nemoclaw_runtime::RuntimeSpec::decode(spec.runtime_configuration()?)? {
        nemoclaw_runtime::RuntimeSpec::Nim(service) => Ok(*service),
        _ => Err(Error::Conflict("runtime configuration is not NIM")),
    }
}
pub(crate) fn service_address(name: &str) -> String {
    address(SERVICE_KIND, name)
}
fn address(kind: &str, name: &str) -> String {
    format!("{}.inference_{name}", crate::compile::resource_type(kind))
}
impl Service {
    pub fn published_placement(&self) -> Result<Option<PublishedPlacement<'_>>, ConfigError> {
        PublishedPlacement::from_parts(self.placement.as_ref(), self.publication.as_ref())
    }
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("nim", self)?;
        if let Some(placed) = self.published_placement()? {
            placed.validate(i64::from(self.serving.port))?;
        }
        let file = &self.ngc_credential.file;
        crate::config::validation::require(
            file.starts_with('/')
                && file.len() <= 4096
                && !file.chars().any(char::is_control)
                && file[1..]
                    .split('/')
                    .all(|part| !part.is_empty() && !matches!(part, "." | "..")),
            "NIM NGC credential requires an absolute Docker-host file path",
        )?;
        crate::config::validation::require(
            crate::config::private_network(&self.backend_network_cidr).is_some(),
            "NIM backend network requires a canonical private IPv4 /24",
        )?;
        self.runtime.validate()
    }
}
fn specification(
    document: &Document,
    name: &str,
    service: &Service,
    generations: &Generations,
) -> Result<Spec, Error> {
    let placed = ResolvedPlacement::resolve(
        service.published_placement()?,
        &document.spec.gateway,
        i64::from(service.serving.port),
    )?;
    let mut labels =
        std::collections::BTreeMap::from([("org.nemoclaw.backend".into(), "nim".into())]);
    if service.authentication.is_some() {
        labels.insert(
            "org.nemoclaw.inference.authentication".into(),
            "bearer-v1".into(),
        );
    }
    let process = base::managed_process(
        nemoclaw_runtime::RuntimeSpec::Nim(Box::new(service.runtime.clone())),
        service.container.as_ref(),
        Process {
            engine: placed.engine.clone(),
            image: service.image.clone(),
            network_cidr: placed.network_cidr,
            create_network: placed.explicit,
            architecture: service.architecture()?.into(),
            image_labels: labels,
            bind_address: placed.bind_address,
            port: service.serving.port,
            ..Process::default()
        },
    )?;
    base::specification(
        document,
        generations,
        SERVICE_KIND,
        format!("{}-inference-{name}", document.workspace()),
        if placed.explicit {
            Default::default()
        } else {
            document.spec.gateway.managed()?.runtime_settings()
        },
        process,
    )
}
impl Installer for Service {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let spec = specification(document, name, self, generations)?;
        let mut preparation = InstallPlan::default();
        if self.authentication.is_some() {
            let credentials = address(STORAGE_KIND, &format!("{name}_auth"));
            preparation.targets.push(base::storage_target(
                &spec,
                STORAGE_KIND,
                credentials.clone(),
                format!("{}-auth", spec.name),
            )?);
            preparation
                .dependencies
                .insert(service_address(name), vec![credentials]);
        }
        if document.spec.gateway.as_managed().is_some() && self.placement.is_none() {
            preparation
                .dependencies
                .entry(service_address(name))
                .or_default()
                .push("openshell_podman_gateway.runtime".into());
        }
        base::install(
            spec,
            &format!("inference_{name}"),
            STORAGE_KIND,
            self.image_pull_policy,
            [
                (
                    "ngc_credential_file".into(),
                    self.ngc_credential.file.clone(),
                ),
                (
                    "backend_network_cidr".into(),
                    self.backend_network_cidr.clone(),
                ),
            ]
            .into(),
            preparation,
        )
    }
    fn remove(&self, _: &Document, name: &str, _: &Generations) -> Result<RemovePlan, Error> {
        let mut plan = RemovePlan {
            retained: vec![crate::docker_compute::address(&address(STORAGE_KIND, name))],
            required_storage: Vec::new(),
        };
        if self.authentication.is_some() {
            let storage = address(STORAGE_KIND, &format!("{name}_auth"));
            plan.retained.insert(0, storage.clone());
            plan.required_storage.push((service_address(name), storage));
        }
        Ok(plan)
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
        let spec = specification(document, name, self, generations)?;
        Ok(Some(crate::services::authentication::source_json(
            &crate::services::authentication::Source::ManagedService {
                storage: base::storage(&spec, format!("{}-auth", spec.name)),
                container: spec.name.clone(),
                endpoint: ResolvedPlacement::resolve(
                    self.published_placement()?,
                    &document.spec.gateway,
                    i64::from(self.serving.port),
                )?
                .endpoint,
            },
        )?))
    }
}
