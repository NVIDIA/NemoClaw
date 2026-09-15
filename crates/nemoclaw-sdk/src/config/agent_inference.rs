// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
/// Wire API used by the agent through OpenShell; no protocol conversion is implied.
pub enum InferenceApi {
    OpenaiCompletions,
    OpenaiResponses,
    AnthropicMessages,
}
impl InferenceApi {
    pub fn for_harness(harness: &str) -> Self {
        match harness {
            "claude" => Self::AnthropicMessages,
            "codex" => Self::OpenaiResponses,
            _ => Self::OpenaiCompletions,
        }
    }
    pub fn supported(self, harness: &str) -> bool {
        matches!(harness, "openclaw" | "hermes") || self == Self::for_harness(harness)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
/// Native reasoning effort; default leaves the harness choice in place.
pub enum ReasoningEffort {
    Default,
    Low,
    Medium,
    High,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Optional OpenClaw model limits and reasoning defaults. Omission preserves native defaults.
pub struct RouteTuning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32", range(min = 1, max = 4194304))]
    /// Model context capacity in tokens. Does not resize the inference server.
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32", range(min = 1, max = 1000000000))]
    /// Maximum output tokens advertised to OpenClaw.
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "bool")]
    /// Whether the model supports reasoning.
    pub reasoning: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "ReasoningEffort")]
    /// Default reasoning effort. The value default leaves the native choice in place.
    pub reasoning_effort: Option<ReasoningEffort>,
}
impl RouteTuning {
    pub fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        if (self != &Self::default() && harness != "openclaw")
            || self
                .context_window
                .is_some_and(|n| !(1..=4194304).contains(&n))
            || self
                .max_tokens
                .is_some_and(|n| !(1..=1000000000).contains(&n))
        {
            return Err(ConfigError(
                "route tuning requires OpenClaw and supported token bounds",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
/// Hermes authentication method supported through the OpenShell provider.
pub enum AuthMethod {
    ApiKey,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Authenticate Hermes inference using the primary route's credential-bearing provider.
pub struct AgentAuth {
    /// API-key authentication. Interactive login is not supported.
    pub method: AuthMethod,
    /// Must equal the primary route's providerRef. Secret values stay in OpenShell.
    pub provider_ref: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
/// OpenClaw tool restriction or discovery mode. These forms are mutually exclusive.
pub enum AgentTools {
    /// Expose only the read tool, independently of the gateway's discovery mode.
    ReadOnly {
        /// Exactly the read tool. Empty lists, wildcards, and other tool names are rejected.
        allow: [AllowedTool; 1],
    },
    /// Select the shared gateway's tool discovery mode without granting additional tools.
    Disclosure {
        /// Progressive uses structured tool search; direct exposes tools directly. Unrestricted agents must agree; omission means progressive.
        disclosure: ToolDisclosure,
    },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
/// OpenClaw tool presentation; this does not change tool permissions.
pub enum ToolDisclosure {
    /// Discover tools through structured search, with default limit 8 and maximum 20.
    Progressive,
    /// Disable tool search and expose permitted tools directly.
    Direct,
}
impl ToolDisclosure {
    pub(crate) fn shared<'a>(
        tools: impl Iterator<Item = Option<&'a AgentTools>>,
    ) -> Result<Self, ConfigError> {
        let mut selected = None;
        for tool in tools {
            let mode = match tool {
                Some(AgentTools::ReadOnly { .. }) => continue,
                Some(AgentTools::Disclosure { disclosure }) => *disclosure,
                None => Self::Progressive,
            };
            if selected.is_some_and(|prior| prior != mode) {
                return Err(ConfigError(
                    "OpenClaw agents must share a tool disclosure mode; omission means progressive",
                ));
            }
            selected = Some(mode);
        }
        Ok(selected.unwrap_or(Self::Progressive))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
/// Tool supported by the read-only OpenClaw policy.
pub enum AllowedTool {
    /// Read a file within the sandbox's filesystem permissions.
    Read,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeAgent {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<AgentTools>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeInference {
    #[serde(rename = "webSearch", default, skip_serializing_if = "Option::is_none")]
    pub web_search: Option<WebSearch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observability: Option<AgentObservability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<AgentExecution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfaces: Option<AgentInterfaces>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<RuntimeAgent>,
    pub api: InferenceApi,
    pub tuning: RouteTuning,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<AgentAuth>,
}
impl RuntimeInference {
    pub fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        self.tuning.validate(harness)?;
        if let Some(search) = &self.web_search {
            search.validate(
                harness,
                self.agents
                    .iter()
                    .map(|a| (a.name.as_str(), a.tools.as_ref())),
            )?;
        }
        if let Some(observability) = &self.observability {
            observability.validate(harness)?;
        }
        if let Some(execution) = &self.execution {
            execution.validate(harness)?;
        }
        if let Some(interfaces) = &self.interfaces {
            interfaces.validate(harness)?;
        }
        ToolDisclosure::shared(self.agents.iter().map(|a| a.tools.as_ref()))?;
        let mut names = std::collections::BTreeSet::new();
        if !self.agents.is_empty()
            && (harness != "openclaw"
                || self
                    .agents
                    .iter()
                    .any(|a| !super::validation::SLUG.is_match(&a.name) || !names.insert(&a.name)))
        {
            return Err(ConfigError("invalid OpenClaw agent roster"));
        }
        if !self.api.supported(harness)
            || self
                .auth
                .as_ref()
                .is_some_and(|a| harness != "hermes" || a.provider_ref.is_empty())
        {
            return Err(ConfigError("unsupported agent inference settings"));
        }
        Ok(())
    }
}
impl Document {
    pub(crate) fn runtime_inference(&self) -> Option<RuntimeInference> {
        let agent = &self.spec.sandboxes[0].agents[0];
        let provider = &self.spec.inference_providers[0];
        let tuning = &agent.inference.routes[0].overrides.tuning;
        let agents = &self.spec.sandboxes[0].agents;
        let roster = self.spec.sandboxes[0].web_search().is_some()
            || agents.len() > 1
            || agents.iter().any(|a| a.tools.is_some());
        (provider.api.is_some()
            || tuning != &RouteTuning::default()
            || agent.auth.is_some()
            || roster
            || agent.execution.is_some()
            || agent.observability.is_some()
            || agent.interfaces.is_some())
        .then(|| RuntimeInference {
            web_search: self.spec.sandboxes[0].web_search().cloned(),
            observability: agent.observability.clone(),
            execution: agent.execution.clone(),
            interfaces: agent.interfaces.clone(),
            agents: if roster {
                agents
                    .iter()
                    .map(|a| RuntimeAgent {
                        name: a.name.clone(),
                        tools: a.tools.clone(),
                    })
                    .collect()
            } else {
                Vec::new()
            },
            api: provider
                .api
                .unwrap_or(InferenceApi::for_harness(&agent.harness)),
            tuning: tuning.clone(),
            auth: agent.auth.clone(),
        })
    }
}
