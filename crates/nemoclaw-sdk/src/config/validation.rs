// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use regex::Regex;
use std::{
    net::{IpAddr, SocketAddr},
    sync::LazyLock,
};
use url::Url;

pub(crate) static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::SLUG).unwrap());
static UUID: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::UUID).unwrap());
static ENV: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::ENV).unwrap());
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::MODEL).unwrap());
static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::IMAGE).unwrap());
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
pub(crate) fn credential(value: &Option<Credential>) -> Result<(), ConfigError> {
    require(
        value.as_ref().is_none_or(|c| ENV.is_match(&c.env)),
        "credential references require an uppercase environment variable name",
    )
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
    constraints::HARNESSES.contains(&harness)
}
impl Document {
    pub fn validate(&self) -> Result<(), ConfigError> {
        require(
            self.api_version == API_VERSION && self.kind == constraints::KIND,
            "expected nemoclaw.nvidia.com/v1alpha1 NemoClawConfig",
        )?;
        require(
            SLUG.is_match(&self.metadata.name) && UUID.is_match(&self.metadata.uid),
            "metadata requires a lowercase name and immutable UUID",
        )?;
        let gateway = &self.spec.gateway;
        require(
            constraints::MANAGEMENT.contains(&gateway.management.as_str()),
            "gateway management must be external or managed",
        )?;
        if gateway.management == "managed" {
            gateway.validate_managed()?;
            if self
                .spec
                .sandboxes
                .iter()
                .any(|sandbox| sandbox.runtime.provider == "docker")
            {
                super::ImagePullPolicy::validate_service(gateway.image_pull_policy)?;
            }
        } else {
            require(
                gateway.engine.is_empty()
                    && gateway.image.is_empty()
                    && gateway.image_pull_policy.is_none()
                    && gateway.network_cidr.is_empty(),
                "external gateway cannot declare managed runtime settings",
            )?;
        }
        validate_endpoint(&gateway.endpoint, true)?;
        credential(&gateway.credential)?;
        if let Some(tls) = &gateway.tls {
            for c in [&tls.ca, &tls.certificate, &tls.key] {
                require(
                    ENV.is_match(&c.env),
                    "TLS requires environment variable references",
                )?;
            }
        }
        require(
            !gateway.endpoint.starts_with("http:")
                || (gateway.credential.is_none() && gateway.tls.is_none()),
            "gateway credentials require HTTPS",
        )?;
        require(
            !self.spec.sandboxes.is_empty() && self.spec.sandboxes.len() <= 32,
            "between one and 32 sandboxes are required",
        )?;
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
            require(
                SLUG.is_match(&sandbox.name) && IMAGE.is_match(&sandbox.image.ref_),
                "sandbox requires a lowercase name and image pinned by SHA-256 digest",
            )?;
            require(
                constraints::RUNTIMES.contains(&sandbox.runtime.provider.as_str()),
                "sandbox runtime must be docker or podman",
            )?;
            require(
                gateway.management != "managed"
                    || self
                        .spec
                        .sandboxes
                        .iter()
                        .all(|other| other.runtime.provider == sandbox.runtime.provider),
                "managed gateway requires every sandbox to select the same runtime driver",
            )?;
            sandbox.network.validate()?;
            let harness = self.sandbox_harness(sandbox)?;
            sandbox.network.validate_runtime_access(&harness.kind)?;
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
                    &harness.kind,
                    std::iter::once((sandbox.agent.name.as_str(), sandbox.agent.tools.as_ref())),
                )?;
            }
            let agent = &sandbox.agent;

            if let Some(tools) = &agent.tools {
                tools.validate(&harness.kind)?;
            }
            require(
                SLUG.is_match(&agent.name),
                "agent requires a lowercase name",
            )?;

            require(
                self.sandbox_inference(sandbox)?.routes.len() == 1
                    || matches!(harness.kind.as_str(), "openclaw" | "pi"),
                "multiple model choices require OpenClaw or Pi",
            )?;
            let inference = self.scoped_inference(sandbox)?;
            for route in &inference.inference.routes {
                let selected = self.route_provider(route, &inference)?;
                let provider = selected.definition;
                require(
                    harness.kind != "pi" || provider.api.is_none(),
                    "Pi selects its API through model metadata; omit provider api",
                )?;
                let api = provider
                    .api
                    .unwrap_or(InferenceApi::for_harness(&harness.kind));
                require(
                    api.supported(&harness.kind)
                        && (api == InferenceApi::AnthropicMessages)
                            == (provider.provider == "anthropic"),
                    "API must match the provider implementation and be supported by the harness",
                )?;
                if agent.auth.is_some() {
                    require(
                        harness.kind == "hermes"
                            && crate::services::provider_authenticated(self, provider)?,
                        "Hermes API-key auth must reference the routed provider with a credential",
                    )?;
                }
                route.overrides.tuning.validate(&harness.kind)?;
                require(
                    route.overrides.pi_model.is_none() || harness.kind == "pi",
                    "piModel is supported only by the Pi harness",
                )?;
                crate::services::validate_route(
                    self,
                    provider,
                    &sandbox.runtime.provider,
                    &harness.kind,
                    &route.overrides.model,
                )?;
            }
        }
        Ok(())
    }
}
impl Gateway {
    pub fn validate_managed(&self) -> Result<(), ConfigError> {
        let url =
            Url::parse(&self.endpoint).map_err(|_| ConfigError::new("invalid gateway endpoint"))?;
        let authority = self
            .endpoint
            .strip_prefix("http://")
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        let bind = authority.parse::<SocketAddr>().ok();
        require(
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && bind.is_some_and(|a| a.port() >= 1024)
                && self.credential.is_none()
                && self.tls.is_none()
                && self.engine.starts_with("unix:///")
                && crate::docker::Engine::validate_endpoint(&self.engine).is_ok()
                && self.image == DEFAULT_GATEWAY_IMAGE,
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
        require(
            SLUG.is_match(&provider.name)
                && constraints::PROVIDERS.contains(&provider.provider.as_str()),
            "provider requires a lowercase name and openai or anthropic implementation",
        )?;
        if !managed {
            validate_endpoint(&provider.endpoint, false)?;
        }
        credential(&provider.credential)?;
        require(
            provider.credential.is_none() || !provider.endpoint.starts_with("http:"),
            "inference credentials require HTTPS",
        )?;
        Ok(())
    }
}

pub(super) fn valid_model(model: &str) -> bool {
    MODEL.is_match(model)
}
