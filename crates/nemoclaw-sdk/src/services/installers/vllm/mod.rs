// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! vLLM installer launch behavior; model and hardware qualification belongs to recipes.
use super::inference::{self, address};
mod config;
mod hardware_profile;
mod service_hardware;
pub use super::container::{ServiceContainer, ServiceIpc};
use crate::Error;
pub use crate::services::placement::{ServicePlacement, ServicePublication};
pub use config::{Memory, Model, Service, ServiceAuthentication, Serving};
pub use hardware_profile::HardwareProfile;
#[cfg(test)]
use nemoclaw_runtime::vllm::arguments;
pub use service_hardware::{DedicatedHardware, ServiceHardware, VllmLaunchMode};
pub(crate) mod schema;
#[cfg(test)]
mod tests;

use crate::{
    compile::Generations,
    config::{ConfigError, Document},
    managed::Spec,
    services::contract::{InstallPlan, Installer, RemovePlan},
};

pub const SERVICE_KIND: &str = "inference_service";
pub const STORAGE_KIND: &str = "inference_storage";
/// Data source that computes the vLLM runtime contract.
pub const RUNTIME_DATA_SOURCE: &str = "vllm_runtime";

/// OpenTofu attributes for the vLLM runtime contract.
pub fn runtime_fields() -> Result<crate::hcl_schema::Fields, crate::hcl_schema::Unmappable> {
    let schema = schemars::schema_for!(nemoclaw_runtime::vllm::Service).to_value();
    crate::hcl_schema::fields(&schema, &[])
}

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

/// The address of the service's model container resource.
pub(crate) fn service_address(name: &str) -> String {
    address(SERVICE_KIND, name)
}

fn specification(
    document: &Document,
    name: &str,
    service: &Service,
    generations: &Generations,
) -> Result<Spec, Error> {
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
        image_labels.insert("org.nemoclaw.inference.routes".into(), "openai-v2".into());
    }
    inference::specification(
        document,
        name,
        generations,
        inference::Runtime {
            contract: nemoclaw_runtime::RuntimeSpec::Vllm(Box::new(runtime_service)),
            container: service.container.as_ref(),
            image: &service.image,
            placement: service.published_placement()?,
            architecture: service.architecture()?.into(),
            labels: image_labels,
            port: service.serving.port as u16,
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
            Default::default(),
        )
    }

    fn remove(
        &self,
        _document: &Document,
        name: &str,
        _generations: &Generations,
    ) -> Result<RemovePlan, Error> {
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
        // The key source names the endpoint sandboxes use, as the
        // registration does.
        inference::credential_source(
            &spec,
            crate::services::placement::ResolvedPlacement::resolve(
                self.published_placement()?,
                &document.spec.gateway,
                self.serving.port,
            )?
            .endpoint,
        )
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
