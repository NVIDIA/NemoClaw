// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed authenticated proxy for an external, loopback-only Ollama daemon and installed model.
pub struct OllamaProxy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ManagedManagement")]
    /// Optional ownership declaration; omission means managed.
    pub management: Option<ManagedManagement>,
    /// Local Unix Docker socket. The external daemon runs on this same Linux host.
    pub engine: String,
    /// Immutable NemoClaw Ollama proxy image built locally.
    pub image: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ImagePullPolicy")]
    /// Image acquisition before container creation or restart. Omission means IfNotPresent; changing this does not restart a running container.
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Private or loopback HTTP IPv4:port/v1 published by the proxy and reachable by OpenShell.
    pub endpoint: String,
    /// Digest of the already-installed route model. NemoClaw never installs or deletes it.
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
}
impl OllamaProxy {
    pub(crate) fn validate(
        &self,
        provider: &InferenceProvider,
        model: &str,
        harness: &str,
    ) -> Result<(), ConfigError> {
        validate_endpoint(&self.endpoint, false)?;
        let upstream = url::Url::parse(&provider.endpoint)
            .map_err(|_| ConfigError::new("invalid Ollama upstream"))?;
        let endpoint = url::Url::parse(&self.endpoint)
            .map_err(|_| ConfigError::new("invalid proxy endpoint"))?;
        let loopback = match upstream.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        if provider.provider != "openai"
            || provider.service.is_some()
            || provider.ollama.is_some()
            || provider.credential.is_some()
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
            || self.endpoint == provider.endpoint
            || self.engine.contains(['$', '%', '{', '}', '\r', '\n', '\0'])
            || !self.engine.starts_with("unix:///")
            || crate::docker::Engine::validate_endpoint(&self.engine).is_err()
            || !regex::Regex::new(constraints::IMAGE)
                .unwrap()
                .is_match(&self.image)
            || !regex::Regex::new("^[a-f0-9]{64}$")
                .unwrap()
                .is_match(&self.model.digest)
            || !regex::Regex::new(constraints::OLLAMA_MODEL)
                .unwrap()
                .is_match(model)
        {
            return Err(ConfigError::new(
                "Ollama proxy requires a local external daemon, pinned installed model, private endpoint, and OpenClaw, Hermes, Deep Agents, or Pi completions",
            ));
        }
        Ok(())
    }
}
