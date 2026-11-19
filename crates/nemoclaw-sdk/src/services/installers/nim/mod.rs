// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Compose native NIM storage and supervised inference through Docker.
mod config;
use super::{
    inference::{self, address},
    vllm::SERVICE_KIND,
};
use crate::{
    Error,
    compile::Generations,
    config::{ConfigError, Document},
    managed::Spec,
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
    let mut labels =
        std::collections::BTreeMap::from([("org.nemoclaw.backend".into(), "nim".into())]);
    if service.authentication.is_some() {
        labels.insert(
            "org.nemoclaw.inference.authentication".into(),
            "bearer-v1".into(),
        );
    }
    inference::specification(
        document,
        name,
        generations,
        inference::Runtime {
            contract: nemoclaw_runtime::RuntimeSpec::Nim(Box::new(service.runtime.clone())),
            container: service.container.as_ref(),
            image: &service.image,
            placement: service.published_placement()?,
            architecture: service.architecture()?.into(),
            labels,
            port: service.serving.port,
        },
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
        inference::install(
            spec,
            name,
            self.authentication.is_some(),
            document.spec.gateway.as_managed().is_some() && self.placement.is_none(),
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
        )
    }
    fn remove(&self, _: &Document, name: &str, _: &Generations) -> Result<RemovePlan, Error> {
        Ok(inference::remove(name, self.authentication.is_some()))
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
        inference::credential_source(
            &spec,
            ResolvedPlacement::resolve(
                self.published_placement()?,
                &document.spec.gateway,
                i64::from(self.serving.port),
            )?
            .endpoint,
        )
    }
}
