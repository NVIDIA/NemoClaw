// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    config::{
        ConfigError, ExternalManagement, InferenceApi, InferenceProvider, ManagedManagement,
        constraints, validate_endpoint,
    },
    services::ServiceRuntime,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed Ollama uses a pinned image, an existing Docker network, and one explicit model tag.
pub struct ManagedOllama {
    /// Optional model-volume ownership declaration. Omission means managed; the volume survives destroy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::config::ManagedResource")]
    pub storage: Option<crate::config::ManagedResource>,
    /// Optional ownership declaration for the Ollama daemon container. Omission means managed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::config::ManagedManagement")]
    pub management: Option<crate::config::ManagedManagement>,
    /// Docker runner and pinned ollama/ollama image.
    pub runtime: ServiceRuntime,
    /// Private or loopback HTTP IPv4:port/v1 published by the managed daemon.
    pub endpoint: String,
    /// Name of the existing Docker network.
    pub network: crate::config::NetworkReference,
    /// Selected model installed and verified by the Ollama installer.
    pub model: OllamaModel,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// One managed Ollama model installation.
pub struct OllamaModel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "crate::config::ManagedManagement")]
    /// Optional ownership declaration; omission means managed.
    pub management: Option<crate::config::ManagedManagement>,
    /// Explicit Ollama model name including its tag.
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed authenticated proxy for an external, loopback-only Ollama daemon and installed model.
pub struct OllamaProxy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ManagedManagement")]
    /// Optional ownership declaration; omission means managed.
    pub management: Option<ManagedManagement>,
    /// Docker runner and immutable NemoClaw proxy image. The external daemon runs on this same Linux host.
    pub runtime: ServiceRuntime,
    /// Private or loopback HTTP IPv4:port/v1 published by the proxy and reachable by OpenShell.
    pub endpoint: String,
    /// External loopback-only daemon and already-installed model.
    pub upstream: ExternalOllama,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// External Ollama daemon observed by the managed proxy installer.
pub struct ExternalOllama {
    /// Loopback-only Ollama HTTP endpoint ending in /v1.
    pub endpoint: String,
    /// Existing model verified before the proxy starts.
    pub model: ExternalOllamaModel,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Existing Ollama model installation, independently owned outside the deployment.
pub struct ExternalOllamaModel {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ExternalManagement")]
    /// Optional ownership declaration; omission means external.
    pub management: Option<ExternalManagement>,
    #[schemars(regex(pattern = "^[a-f0-9]{64}$"))]
    /// Lowercase 64-character model digest reported by Ollama's /api/tags API.
    pub digest: String,
    /// Installed Ollama model name including its tag.
    pub name: String,
}
impl OllamaProxy {
    pub(crate) fn validate(
        &self,
        provider: &InferenceProvider,
        model: &str,
        harness: &str,
    ) -> Result<(), ConfigError> {
        validate_endpoint(&self.endpoint, false)?;
        let upstream = url::Url::parse(&self.upstream.endpoint)
            .map_err(|_| ConfigError::new("invalid Ollama upstream"))?;
        let endpoint = url::Url::parse(&self.endpoint)
            .map_err(|_| ConfigError::new("invalid proxy endpoint"))?;
        let loopback = match upstream.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if provider.provider != "openai"
            || provider.credential.is_some()
            || !provider.endpoint.is_empty()
            || provider.service_ref.is_none()
            || provider
                .api
                .is_some_and(|api| api != InferenceApi::OpenaiCompletions)
            || !matches!(harness, "openclaw" | "hermes" | "deepagents" | "pi")
            || !loopback
            || upstream.scheme() != "http"
            || upstream.path() != "/v1"
            || upstream.port().is_none()
            || !matches!(endpoint.host(), Some(url::Host::Ipv4(_)))
            || endpoint.scheme() != "http"
            || endpoint.path() != "/v1"
            || endpoint.port().is_none()
            || self.endpoint == self.upstream.endpoint
            || self.runtime.provider != "docker"
            || self
                .runtime
                .engine
                .contains(['$', '%', '{', '}', '\r', '\n', '\0'])
            || !self.runtime.engine.starts_with("unix:///")
            || crate::docker::Engine::validate_endpoint(&self.runtime.engine).is_err()
            || !regex::Regex::new(constraints::IMAGE)
                .unwrap()
                .is_match(&self.runtime.image)
            || !regex::Regex::new("^[a-f0-9]{64}$")
                .unwrap()
                .is_match(&self.upstream.model.digest)
            || !regex::Regex::new(super::MODEL_PATTERN)
                .unwrap()
                .is_match(&self.upstream.model.name)
            || self.upstream.model.name != model
        {
            return Err(ConfigError::new(
                "Ollama proxy requires a local external daemon, pinned installed model, private endpoint, and OpenClaw, Hermes, Deep Agents, or Pi completions",
            ));
        }
        Ok(())
    }
}
