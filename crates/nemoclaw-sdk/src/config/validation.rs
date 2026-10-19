// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::net::SocketAddr;

pub(crate) fn require(valid: bool, reason: &'static str) -> Result<(), ConfigError> {
    if valid {
        Ok(())
    } else {
        Err(ConfigError::new(reason))
    }
}

pub use nemoclaw_backend::{validate_endpoint, validate_endpoint_url};

pub fn is_fabric_harness(harness: &str) -> bool {
    harness.parse::<super::HarnessKind>().is_ok()
}
impl Document {
    pub fn validate(&self) -> Result<(), ConfigError> {
        schema::validate_document(self)?;
        let gateway = &self.spec.gateway;
        if let Gateway::Managed(gateway) = gateway {
            gateway.validate_managed()?;
        }
        if let Gateway::External(gateway) = gateway
            && !gateway.engine.is_empty()
        {
            super::validate_engine_endpoint(&gateway.engine)?;
        }
        validate_endpoint(gateway.endpoint(), true)?;
        self.validate_harness_references()?;
        let selected_providers = self.selected_inference_providers()?;
        crate::services::validate(self)?;
        self.validate_inference_references()?;
        for definition in self.provider_definitions() {
            self.validate_provider(definition)?;
        }
        let mut sandbox_names = std::collections::BTreeSet::new();
        for sandbox in &self.spec.sandboxes {
            require(
                self.spec.gateway.runtime().provider.is_kubernetes()
                    || sandbox.image.metadata.is_none(),
                "image.metadata is available only for Kubernetes and OpenShift; Docker and Podman use engine image inspection",
            )?;
            if let Some(metadata) = &sandbox.image.metadata {
                schema::validate_definition("FileRef", metadata)?;
            }
            require(
                sandbox_names.insert(&sandbox.name),
                "sandbox names must be unique",
            )?;
            sandbox.network.validate()?;
            let web_search = self.web_search(sandbox)?;
            crate::image_runtime::policy_input(self, sandbox)?;
            if let Some(search) = web_search {
                require(
                    selected_providers.iter().all(|provider| {
                        provider.name != "brave-search"
                            && !provider.name.starts_with("brave-search-")
                            && provider.name != "tavily-search"
                            && !provider.name.starts_with("tavily-search-")
                    }),
                    "brave-search and tavily-search names are reserved for web search",
                )?;
                search.validate(std::iter::once((
                    sandbox.agent.name.as_str(),
                    sandbox.agent.tools.as_ref(),
                )))?;
            }
            let image_scope = self.image_scope(sandbox)?;
            for api in self.apis(sandbox)? {
                require(
                    !api.agent_refs.is_empty()
                        && api
                            .agent_refs
                            .iter()
                            .all(|name| name == &sandbox.agent.name),
                    "an api integration requires references to the sandbox's agent",
                )?;
                schema::validate_definition("SecretRef", &api.api.credential)?;
                let registration = api.registration(&image_scope);
                require(
                    selected_providers
                        .iter()
                        .all(|provider| provider.name != registration),
                    "an inference provider name collides with an api integration's registration",
                )?;
            }
            let agent = &sandbox.agent;

            if let Some(tools) = &agent.tools {
                tools.validate()?;
            }
            let inference = self.scoped_inference(sandbox)?;
            for route in &inference.inference.routes {
                let selected = self.route_provider(route, &inference)?;
                let provider = selected.definition;
                if agent.auth.is_some() {
                    require(
                        crate::services::provider_authenticated(self, provider)?,
                        "API-key auth must reference the routed provider with a credential",
                    )?;
                }
                route.overrides.tuning.validate()?;
                crate::services::validate_route(
                    self,
                    provider,
                    self.spec.gateway.runtime().provider,
                    &route.overrides.model,
                )?;
            }
        }
        Ok(())
    }
}
impl super::ManagedGateway {
    pub fn validate_managed(&self) -> Result<(), ConfigError> {
        schema::validate_definition("Gateway", &Gateway::Managed(self.clone()))?;
        if let Some(config) = &self.config {
            let driver = if self.kubernetes.is_some() {
                "kubernetes"
            } else {
                self.runtime.provider.as_str()
            };
            crate::managed::gateway_config::check(config, driver).map_err(ConfigError)?;
        }
        if self.kubernetes.is_some() {
            return validate_endpoint(&self.endpoint, true);
        }
        let authority = self
            .endpoint
            .strip_prefix("http://")
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        let bind = authority.parse::<SocketAddr>().ok();
        require(
            bind.is_some_and(|a| a.port() >= 1024)
                && crate::config::validate_engine_endpoint(&self.engine).is_ok(),
            "managed gateway requires a local engine socket and an unprivileged loopback HTTP port without credentials",
        )?;
        let net = self.network_cidr.parse::<ipnet::Ipv4Net>().ok();
        require(
            net.is_some_and(|n| {
                n.addr().is_private() && n.prefix_len() == 24 && n.addr() == n.network()
            }),
            "managed gateway requires a private IPv4 /24 network",
        )
    }
}
impl Document {
    fn validate_provider(&self, provider: &InferenceProvider) -> Result<(), ConfigError> {
        match provider.target()? {
            // OpenShell checks the destination when sandboxes connect.
            InferenceTarget::External { endpoint, .. } => validate_endpoint_url(endpoint)?,
            InferenceTarget::Service { .. } => {
                crate::services::validate_provider(self, provider)?;
            }
        }
        Ok(())
    }
}

pub use nemoclaw_openshell::valid_name;
