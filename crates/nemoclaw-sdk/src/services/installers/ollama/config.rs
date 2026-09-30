// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::super::vllm::ServiceContainer;
use crate::config::{ConfigError, ImagePullPolicy};
use crate::config::{InferenceApi, InferenceProvider, InferenceProviderKind};
use crate::services::placement::{ServicePlacement, ServicePublication};
pub use nemoclaw_runtime::ollama::{OllamaMemory, OllamaModel, OllamaServing};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[serde(default, deny_unknown_fields)]
/// Managed GPU Ollama service with an immutable runtime and model snapshot.
pub struct ManagedOllama {
    /// Optional IPC and shared-memory settings for the runtime container.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServiceContainer")]
    pub container: Option<ServiceContainer>,
    /// Immutable runtime image containing Ollama and the NemoClaw supervisor.
    pub image: String,
    /// Image acquisition before container creation. Omission means IfNotPresent.
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Optional remote Docker placement. Requires publication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServicePlacement")]
    pub placement: Option<ServicePlacement>,
    /// Private inference address for an explicitly placed service.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ServicePublication")]
    pub publication: Option<ServicePublication>,
    #[serde(flatten)]
    pub runtime: nemoclaw_runtime::ollama::ManagedOllama,
}

impl std::ops::Deref for ManagedOllama {
    type Target = nemoclaw_runtime::ollama::ManagedOllama;
    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}
impl std::ops::DerefMut for ManagedOllama {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}
impl ManagedOllama {
    pub(crate) fn runtime_settings(&self) -> nemoclaw_runtime::ollama::ManagedOllama {
        self.runtime.clone()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Managed authenticated proxy for an external, loopback-only Ollama daemon and installed model.
pub struct OllamaProxy {
    /// Local Docker Unix socket. Omission uses the managed gateway engine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "String", regex(pattern = r"^unix:///[^?#\x00]*$"))]
    pub engine: Option<String>,
    /// Immutable NemoClaw proxy image. The external daemon runs on the selected Docker host.
    pub image: String,
    /// Image acquisition before container creation. Omission means IfNotPresent.
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
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
    ) -> Result<(), ConfigError> {
        self.validate_definition()?;
        if provider.provider != InferenceProviderKind::Openai
            || provider.credential.is_some()
            || !provider.endpoint.is_empty()
            || provider.service_ref.is_none()
            || provider
                .api
                .is_some_and(|api| api != InferenceApi::OpenaiCompletions)
            || self.upstream.model.name != model
        {
            return Err(ConfigError::new(
                "Ollama proxy requires a local external daemon, pinned installed model, private endpoint, and the OpenAI completions protocol",
            ));
        }
        Ok(())
    }
}
