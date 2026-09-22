// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::net::{IpAddr, SocketAddr};
use url::Url;

pub(crate) fn require(valid: bool, reason: &'static str) -> Result<(), ConfigError> {
    if valid {
        Ok(())
    } else {
        Err(ConfigError::new(reason))
    }
}
fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private(),
        IpAddr::V6(ip) => ip.is_unique_local(),
    }
}
fn host_ip(url: &Url) -> Option<IpAddr> {
    url.host_str()?.trim_matches(['[', ']']).parse().ok()
}
pub(super) fn credential(value: &Option<Credential>) -> Result<(), ConfigError> {
    if let Some(credential) = value {
        schema::validate_definition("Credential", credential)?;
    }
    Ok(())
}

pub fn validate_endpoint(raw: &str, gateway: bool) -> Result<(), ConfigError> {
    require(
        !raw.contains(['\r', '\n', '\t', '$', '%', '{', '}', '\\']),
        "endpoint contains unsupported characters",
    )?;
    let url =
        Url::parse(raw).map_err(|_| ConfigError::new("expected an HTTP or HTTPS endpoint"))?;
    require(
        url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "endpoint must not include credentials, query, or fragment",
    )?;
    require(
        matches!(url.scheme(), "https" | "http"),
        "expected HTTPS or local HTTP",
    )?;
    require(
        !gateway || url.path() == "/" || url.path().is_empty(),
        "gateway endpoint must not include a path",
    )?;
    let ip = host_ip(&url);
    if let Some(ip) = ip {
        let link_local = match ip {
            IpAddr::V4(ip) => ip.is_link_local(),
            IpAddr::V6(ip) => ip.is_unicast_link_local(),
        };
        require(
            !ip.is_unspecified() && !ip.is_multicast() && !link_local,
            "unspecified, multicast, and link-local endpoints are forbidden",
        )?;
    }
    // url normalizes shorthand IPv4 (127.1, integers, octal). Require the literal
    // address spelling from the input so normalization cannot weaken policy.
    let authority = raw
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""))
        .unwrap_or("");
    let literal_host = if authority.starts_with('[') {
        authority
            .split(']')
            .next()
            .unwrap_or("")
            .trim_start_matches('[')
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if url.scheme() == "http" {
        let literal: Option<IpAddr> = literal_host.parse().ok();
        require(
            literal.is_some_and(|ip| ip.is_loopback() || (!gateway && private(ip))),
            "HTTP requires a literal loopback address or private inference address",
        )?;
    }
    require(
        url.host_str()
            .is_none_or(|host| !host.eq_ignore_ascii_case("metadata.google.internal")),
        "metadata endpoints are forbidden",
    )
}

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
                sandbox_names.insert(&sandbox.name),
                "sandbox names must be unique",
            )?;
            sandbox.network.validate()?;
            let harness = self.sandbox_harness(sandbox)?;
            sandbox.network.validate_runtime_access(harness.kind)?;
            let web_search = self.web_search(sandbox)?;
            sandbox.policy_proto(web_search.is_some(), harness.observability.as_ref())?;
            if let Some(search) = web_search {
                require(
                    selected_providers.iter().all(|provider| {
                        provider.name != "brave-search"
                            && !provider.name.starts_with("brave-search-")
                    }),
                    "brave-search names are reserved for web search",
                )?;
                search.validate(
                    harness.kind,
                    std::iter::once((sandbox.agent.name.as_str(), sandbox.agent.tools.as_ref())),
                )?;
            }
            let agent = &sandbox.agent;

            if let Some(tools) = &agent.tools {
                tools.validate(harness.kind)?;
            }
            require(
                self.sandbox_inference(sandbox)?.routes.len() == 1
                    || matches!(harness.kind, HarnessKind::OpenClaw | HarnessKind::Pi),
                "multiple model choices require OpenClaw or Pi",
            )?;
            let inference = self.scoped_inference(sandbox)?;
            for route in &inference.inference.routes {
                let selected = self.route_provider(route, &inference)?;
                let provider = selected.definition;
                require(
                    harness.kind != HarnessKind::Pi || provider.api.is_none(),
                    "Pi selects its API through model metadata; omit provider api",
                )?;
                let api = provider
                    .api
                    .unwrap_or(InferenceApi::for_harness(harness.kind));
                require(
                    api.supported(harness.kind)
                        && (provider.api.is_some()
                            || (api == InferenceApi::AnthropicMessages)
                                == (provider.provider == InferenceProviderKind::Anthropic)),
                    "API must match the provider implementation and be supported by the harness",
                )?;
                if agent.auth.is_some() {
                    require(
                        harness.kind == HarnessKind::Hermes
                            && crate::services::provider_authenticated(self, provider)?,
                        "Hermes API-key auth must reference the routed provider with a credential",
                    )?;
                }
                route.overrides.tuning.validate(harness.kind)?;
                require(
                    route.overrides.pi_model.is_none() || harness.kind == HarnessKind::Pi,
                    "piModel is supported only by the Pi harness",
                )?;
                crate::services::validate_route(
                    self,
                    provider,
                    sandbox.runtime.provider,
                    harness.kind,
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
                && crate::docker::Engine::validate_endpoint(&self.engine).is_ok(),
            "managed gateway requires pinned image, a local engine socket, and unprivileged loopback HTTP port without credentials",
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
        let managed = crate::services::validate_provider(self, provider)?;
        if !managed {
            validate_endpoint(&provider.endpoint, false)?;
        }
        Ok(())
    }
}

pub(crate) fn valid_model(model: &str) -> bool {
    schema::validate_property("Overrides", "model", &model).is_ok()
}

pub(crate) fn valid_name(name: &str) -> bool {
    schema::validate_property("Metadata", "name", &name).is_ok()
}
