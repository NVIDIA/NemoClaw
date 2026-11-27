// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed GGUF service using the existing inference container/storage lifecycle.
use super::inference::{self, address};
mod config;
pub use super::container::ServiceContainer;
use crate::Error;
pub use config::LlamaCpp as Service;
pub const SERVICE_KIND: &str = super::vllm::SERVICE_KIND;
pub const STORAGE_KIND: &str = super::vllm::STORAGE_KIND;
pub const RUNTIME_DATA_SOURCE: &str = "llama_cpp_runtime";

use crate::{
    compile::Generations,
    config::{ConfigError, Document},
    managed::Spec,
    services::contract::{InstallPlan, Installer, RemovePlan},
};

/// OpenTofu attributes for the llama.cpp runtime contract.
pub fn runtime_fields() -> Result<crate::hcl_schema::Fields, crate::hcl_schema::Unmappable> {
    let schema = schemars::schema_for!(nemoclaw_runtime::llama_cpp::LlamaCppService).to_value();
    crate::hcl_schema::fields(&schema, &[])
}

pub fn configured_service(
    spec: &Spec,
) -> Result<nemoclaw_runtime::llama_cpp::LlamaCppService, Error> {
    let configuration = spec.runtime_configuration()?;
    match nemoclaw_runtime::RuntimeSpec::decode(configuration)? {
        nemoclaw_runtime::RuntimeSpec::LlamaCpp(service) => Ok(*service),
        _ => Err(Error::Conflict("runtime configuration is not llama.cpp")),
    }
}

impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("llamaCpp", self)?;
        if let Some(placement) = self.published_placement()? {
            placement.validate(i64::from(self.serving.port))?;
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
    let runtime_service = service.runtime.clone();
    let mut image_labels =
        std::collections::BTreeMap::from([("org.nemoclaw.backend".into(), "llama-cpp".into())]);
    if service.authentication.is_some() {
        image_labels.insert(
            "org.nemoclaw.inference.authentication".into(),
            "bearer-v1".into(),
        );
    }
    inference::specification(
        document,
        name,
        generations,
        inference::Runtime {
            contract: nemoclaw_runtime::RuntimeSpec::LlamaCpp(Box::new(runtime_service)),
            container: service.container.as_ref(),
            image: &service.image,
            placement: service.published_placement()?,
            architecture: service.architecture()?.into(),
            labels: image_labels,
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
                i64::from(self.serving.port),
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
