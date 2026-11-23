// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Whether `name` is a web search's registration name, `<provider>-search-…`.
/// Web search registers as an API credential, so other registrations must not
/// take these names, and output recognizes a web search by them.
fn reserved_for_web_search(name: &str) -> bool {
    ["brave-search", "tavily-search"].iter().any(|prefix| {
        name.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
    })
}

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
            // The oidc profile takes OpenShell's OIDC settings from the
            // authored gateway configuration; OpenShell validates them.
            let table = crate::managed::gateway_config::OIDC_TABLE;
            if gateway.cluster().is_some_and(|target| {
                target.authentication.profile == super::KubernetesAuthenticationProfile::Oidc
            }) && !gateway
                .config
                .as_ref()
                .is_some_and(|config| crate::managed::gateway_config::defines(config, table))
            {
                return Err(ConfigError(format!(
                    "the oidc authentication profile requires spec.gateway.config to define {table}, OpenShell's OIDC settings such as issuer and audience"
                )));
            }
        }
        if let Gateway::External(gateway) = gateway
            && !gateway.target.engine().is_empty()
        {
            super::validate_engine_endpoint(gateway.target.engine())?;
        }
        if let Some(endpoint) = gateway.endpoint() {
            validate_endpoint(&endpoint, true)?;
        }
        if let Some(apf) = gateway.managed_apf() {
            validate_managed_apf(gateway, apf)?;
        }
        self.validate_harness_references()?;
        self.validate_network_references()?;
        let selected_providers = self.selected_providers()?;
        crate::services::validate(self)?;
        self.validate_inference_references()?;
        for definition in self.provider_definitions() {
            self.validate_provider(definition)?;
        }
        for sandbox in self.sandboxes() {
            require(
                self.spec.gateway.compute_driver().is_kubernetes()
                    || sandbox.image.metadata.is_none(),
                "image.metadata is available only for Kubernetes and OpenShift; Docker and Podman use engine image inspection",
            )?;
            if let Some(metadata) = &sandbox.image.metadata {
                schema::validate_definition("FileRef", metadata)?;
            }
            sandbox.network.validate()?;
            require(
                gateway.policy_authority().is_none()
                    || sandbox.network == super::Network::default(),
                "APF authors the policy of every sandbox on a gateway with a policyAuthority, so a sandbox there must not set network.policy, policyRef, grants, or grantRefs",
            )?;
            self.validate_sandbox_providers(sandbox)?;
            let web_search = self.web_search(sandbox)?;
            crate::image_runtime::policy_input(self, sandbox)?;
            if let Some(search) = web_search {
                require(
                    selected_providers
                        .iter()
                        .all(|provider| !reserved_for_web_search(provider.name)),
                    "brave-search and tavily-search names are reserved for web search",
                )?;
                search.validate(std::iter::once(sandbox.agent.name.as_str()))?;
            }
            let image_scope = self.image_scope(sandbox)?;
            for api in self.apis(sandbox)? {
                require(
                    !reserved_for_web_search(&api.name),
                    "brave-search and tavily-search names are reserved for web search",
                )?;
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
                    self.spec.gateway.compute_driver(),
                    &route.overrides.model,
                )?;
            }
        }
        Ok(())
    }
}
/// NemoClaw registers APF only in a configuration file it writes: a managed
/// Docker gateway's.
fn validate_managed_apf(gateway: &Gateway, apf: &super::ManagedApf) -> Result<(), ConfigError> {
    let Gateway::Managed(managed) = gateway else {
        return Err(ConfigError::new(
            "an external gateway's operator registers its interceptors; set spec.gateway.policyAuthority.apf.registration to external",
        ));
    };
    require(
        matches!(managed.target, super::ManagedTarget::Docker(_)),
        "spec.gateway.policyAuthority.apf.registration managed requires the docker target; register APF in spec.gateway.config and set registration to external",
    )?;
    if let Some(key) = managed.config.as_ref().and_then(|config| {
        crate::managed::gateway_config::APF_KEYS
            .into_iter()
            .find(|key| crate::managed::gateway_config::sets(config, key))
    }) {
        return Err(ConfigError(format!(
            "spec.gateway.config sets {key}, which NemoClaw writes when spec.gateway.policyAuthority.apf.registration is managed; remove it"
        )));
    }
    let url = url::Url::parse(&apf.endpoint).ok();
    require(
        url.as_ref().is_some_and(|url| {
            url.scheme() == "https"
                && url.host_str().is_some_and(|host| !host.is_empty())
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && !apf.endpoint.ends_with('/')
        }),
        "spec.gateway.policyAuthority.apf.endpoint must be an https://HOST[:PORT] origin without a path",
    )?;
    if let Some(tls) = &apf.tls {
        schema::validate_definition("FileRef", &tls.ca)?;
    }
    Ok(())
}

impl super::ManagedGateway {
    pub fn validate_managed(&self) -> Result<(), ConfigError> {
        schema::validate_definition("Gateway", &Gateway::Managed(self.clone()))?;
        if let Some(config) = &self.config {
            let driver = if let Some(target) = self.cluster() {
                match target.authentication.profile {
                    super::KubernetesAuthenticationProfile::Oidc => "kubernetes-oidc",
                    super::KubernetesAuthenticationProfile::Development => "kubernetes",
                }
            } else {
                self.compute_driver().as_str()
            };
            crate::managed::gateway_config::check(config, driver).map_err(ConfigError)?;
        }
        // Kubernetes refuses a request above its limit only when Helm
        // creates the gateway's StatefulSet, after apply has created the
        // namespace and issuer; plan refuses it before anything changes.
        if let Some(super::GatewayResources {
            requests: Some(requests),
            limits: Some(limits),
        }) = self.cluster().and_then(|target| target.resources.as_ref())
        {
            let target = match self.target {
                super::ManagedTarget::OpenShift(_) => "openshift",
                _ => "kubernetes",
            };
            for (name, request, limit) in [
                ("cpu", requests.millicores(), limits.millicores()),
                ("memory", requests.mebibytes(), limits.mebibytes()),
            ] {
                if let (Some(request), Some(limit)) = (request, limit)
                    && request > limit
                {
                    return Err(ConfigError(format!(
                        "spec.gateway.target.{target}.resources.requests.{name} must not exceed resources.limits.{name}"
                    )));
                }
            }
        }
        let Some(local) = self.local() else {
            return match self.endpoint() {
                Some(endpoint) => validate_endpoint(&endpoint, true),
                None => Ok(()),
            };
        };
        require(
            local.port >= 1024 && crate::config::validate_engine_endpoint(&local.engine).is_ok(),
            "managed gateway requires a local engine socket and an unprivileged loopback port",
        )?;
        require(
            crate::config::private_network(&local.network_cidr).is_some(),
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
