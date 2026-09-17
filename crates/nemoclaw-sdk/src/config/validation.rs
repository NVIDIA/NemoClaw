// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use regex::Regex;
use std::{
    net::{IpAddr, SocketAddr},
    sync::LazyLock,
};
use url::Url;

pub(super) static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::SLUG).unwrap());
static UUID: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::UUID).unwrap());
static ENV: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::ENV).unwrap());
static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::MODEL).unwrap());
static OLLAMA_MODEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(constraints::OLLAMA_MODEL).unwrap());
static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(constraints::IMAGE).unwrap());
fn require(valid: bool, reason: &'static str) -> Result<(), ConfigError> {
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
fn local(ip: IpAddr) -> bool {
    ip.is_loopback() || private(ip)
}
fn host_ip(url: &Url) -> Option<IpAddr> {
    url.host_str()?.trim_matches(['[', ']']).parse().ok()
}
pub(super) fn credential(value: &Option<Credential>) -> Result<(), ConfigError> {
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
        } else {
            require(
                gateway.engine.is_empty()
                    && gateway.image.is_empty()
                    && gateway.network_cidr.is_empty()
                    && gateway.network.is_none()
                    && gateway.storage.is_none(),
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
        self.lifecycle_provider()?;
        let mut publications = std::collections::BTreeSet::new();
        let mut networks = std::collections::BTreeMap::new();
        if gateway.management == "managed" {
            networks.insert(gateway.engine.as_str(), gateway.network_cidr.as_str());
        }
        for provider in &selected_providers {
            if let Some(service) = &provider.service {
                let engine = service
                    .placement
                    .as_ref()
                    .map_or(gateway.engine.as_str(), |p| p.engine.as_str());
                let cidr = service
                    .placement
                    .as_ref()
                    .map_or(gateway.network_cidr.as_str(), |p| p.network_cidr.as_str());
                require(
                    networks
                        .insert(engine, cidr)
                        .is_none_or(|previous| previous == cidr),
                    "managed services sharing an engine must use the same network CIDR",
                )?;
                let bind = service
                    .publication
                    .as_ref()
                    .map_or_else(|| gateway.bridge(), |p| Ok(p.bind_address.clone()))?;
                require(
                    publications.insert((engine, bind, service.serving.port)),
                    "managed inference publication addresses must be distinct on each engine",
                )?;
            }
        }
        self.validate_inference_references()?;
        for definition in self.provider_definitions() {
            validate_provider(definition, gateway)?;
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
                gateway.management != "managed" || sandbox.runtime.provider == "docker",
                "managed gateway requires the qualified Docker driver",
            )?;
            sandbox.network.validate()?;
            require(!sandbox.agents.is_empty(), "at least one agent is required")?;
            let harness = self.sandbox_harness(sandbox)?;
            sandbox.network.validate_runtime_access(&harness.kind)?;
            require(
                sandbox.agents.len() == 1 || harness.kind == "openclaw",
                "multiple agents require OpenClaw",
            )?;
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
                    sandbox
                        .agents
                        .iter()
                        .map(|a| (a.name.as_str(), a.tools.as_ref())),
                )?;
            }
            ToolDisclosure::shared(sandbox.agents.iter().map(|a| a.tools.as_ref()))?;
            let mut names = std::collections::BTreeSet::new();
            for agent in &sandbox.agents {
                require(names.insert(&agent.name), "agent names must be unique")?;

                require(
                    agent.tools.is_none() || harness.kind == "openclaw",
                    "tool restrictions require OpenClaw",
                )?;
                require(
                    SLUG.is_match(&agent.name),
                    "agent requires a lowercase name",
                )?;

                require(
                    self.agent_inference(agent)?.routes.len() == 1 || harness.kind == "openclaw",
                    "multiple model choices require OpenClaw",
                )?;
                for route in &self.agent_inference(agent)?.routes {
                    let (_, scope) = self.scoped_inference(agent)?;
                    let provider = self.route_provider(route, scope)?;
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
                                && (provider.credential.is_some()
                                    || provider.ollama_proxy.is_some()
                                    || provider
                                        .service
                                        .as_ref()
                                        .is_some_and(|s| s.authentication.is_some())),
                            "Hermes API-key auth must reference the routed provider with a credential",
                        )?;
                    }
                    route.overrides.tuning.validate(&harness.kind)?;
                    require(
                        route.overrides.pi_model.is_none() || harness.kind == "pi",
                        "piModel is supported only by the Pi harness",
                    )?;
                    require(
                        provider.service.is_none()
                            || (route.overrides.model
                                == provider.service.as_ref().unwrap().served_model()
                                && (sandbox.runtime.provider == "docker"
                                    || provider.service.as_ref().unwrap().placement.is_some())),
                        "service requires its declared served model and compatible sandbox placement",
                    )?;
                    if let Some(proxy) = &provider.ollama_proxy {
                        proxy.validate(provider, &route.overrides.model, &harness.kind)?;
                    }
                    if provider.ollama.is_some() || provider.ollama_proxy.is_some() {
                        require(
                            route.overrides.model == self.provider_model(provider)?,
                            "managed Ollama and its proxy support one selected model",
                        )?;
                    }
                    if let Some(ollama) = &provider.ollama {
                        let url = Url::parse(&provider.endpoint)
                            .map_err(|_| ConfigError::new("invalid Ollama endpoint"))?;
                        let authority = provider
                            .endpoint
                            .strip_prefix("http://")
                            .unwrap_or("")
                            .split('/')
                            .next()
                            .unwrap_or("");
                        let bind = authority.parse::<SocketAddr>().ok();
                        require(
                            provider.credential.is_none()
                                && url.scheme() == "http"
                                && url.path() == "/v1"
                                && bind.is_some_and(|a| a.port() != 0 && local(a.ip())),
                            "Ollama requires an explicit private IP:port/v1 HTTP endpoint without credentials",
                        )?;
                        require(
                            ollama.engine.starts_with("unix:///")
                                && !ollama
                                    .engine
                                    .contains(['$', '%', '{', '}', '\r', '\n', '\0'])
                                && SLUG.is_match(ollama.network.name())
                                && IMAGE.is_match(&ollama.image)
                                && ollama.image.starts_with("ollama/ollama@sha256:"),
                            "Ollama requires a local Unix socket, named network, and pinned ollama/ollama image",
                        )?;
                        require(
                            OLLAMA_MODEL.is_match(&route.overrides.model),
                            "Ollama requires an explicit registry-library model:tag",
                        )?;
                    }
                }
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
                && self.engine == constraints::GATEWAY_ENGINE
                && self.image == DEFAULT_GATEWAY_IMAGE,
            "managed gateway requires pinned image, local Docker, and unprivileged loopback HTTP port without credentials",
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
impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
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
            validate_endpoint(&publication.endpoint, false)?;
            let endpoint = url::Url::parse(&publication.endpoint).unwrap();
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

        require(
            IMAGE.is_match(&self.image),
            "Spark requires qualified backend, pinned model, and immutable image",
        )?;
        crate::backends::validation::validate(self)
    }
}

fn validate_provider(provider: &InferenceProvider, gateway: &Gateway) -> Result<(), ConfigError> {
    let management = if provider.service.is_some() || provider.ollama.is_some() {
        Management::Managed
    } else {
        Management::External
    };
    require(
        provider
            .management
            .is_none_or(|declared| declared == management),
        "inference management must match service or Ollama (managed) or endpoint alone (external)",
    )?;
    require(
        SLUG.is_match(&provider.name)
            && constraints::PROVIDERS.contains(&provider.provider.as_str()),
        "provider requires a lowercase name and openai or anthropic implementation",
    )?;
    if let Some(service) = &provider.service {
        require(
            provider.endpoint.is_empty()
                && provider.ollama.is_none()
                && provider.credential.is_none(),
            "managed service excludes endpoint, Ollama, and external credentials",
        )?;
        require(
            gateway.management == "managed" || service.placement.is_some(),
            "service requires a managed gateway or explicit placement",
        )?;
        service.validate()?;
    } else {
        validate_endpoint(&provider.endpoint, false)?;
    }
    credential(&provider.credential)?;
    require(
        provider.credential.is_none() || !provider.endpoint.starts_with("http:"),
        "inference credentials require HTTPS",
    )?;
    Ok(())
}

pub(super) fn valid_model(model: &str) -> bool {
    MODEL.is_match(model)
}
