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
    pub inference: Option<RuntimeAgentInference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<AgentTools>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
// This is the pinned Fabric adapter wire format. Its top-level model mirrors the
// first agent for single-agent adapters; retain the encoding until images change.
pub(crate) struct SandboxRuntimeSettings {
    pub provider: String,
    pub connection: RuntimeConnection,
    #[serde(rename = "webSearch", default, skip_serializing_if = "Option::is_none")]
    pub web_search: Option<RuntimeWebSearch>,
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
    pub auth: Option<RuntimeAuth>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeConnection {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub base_url: String,
    pub api_key_env: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeAgentInference {
    pub default: String,
    pub models: std::collections::BTreeMap<String, RuntimeModel>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuntimeModel {
    pub provider: String,
    pub connection: RuntimeConnection,
    pub api: InferenceApi,
    pub tuning: RouteTuning,
}

// Keep the adapter wire contract while deriving authentication from the selected route.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimeAuth {
    pub method: AuthMethod,
    pub provider_ref: String,
}
impl RuntimeConnection {
    fn validate(&self, provider: &str, harness: &str) -> Result<(), ConfigError> {
        super::validate_endpoint(&self.base_url, false)?;
        let profile = crate::openshell::inference_profile(
            provider,
            &self.base_url,
            &self.provider,
            self.api_key_env != "NEMOCLAW_ANONYMOUS_API_KEY",
        )
        .map_err(|_| ConfigError("invalid native inference connection"))?;
        if profile
            .credentials
            .first()
            .map(|c| c.name.as_str())
            .unwrap_or("NEMOCLAW_ANONYMOUS_API_KEY")
            != self.api_key_env
        {
            return Err(ConfigError(
                "inference credential does not match its provider",
            ));
        }
        if self.model.is_none() != (harness == "pi")
            || self
                .model
                .as_deref()
                .is_some_and(|model| !super::validation::valid_model(model))
        {
            return Err(ConfigError("invalid native inference model"));
        }
        Ok(())
    }
}

impl SandboxRuntimeSettings {
    pub fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        self.connection.validate(&self.provider, harness)?;
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
            if observability.uses_relay() && self.interfaces.is_some() {
                return Err(ConfigError(
                    "Hermes Relay tracing cannot be combined with native Hermes interfaces",
                ));
            }
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
        let explicit_choices = self.agents.iter().any(|agent| agent.inference.is_some());
        if explicit_choices {
            for agent in &self.agents {
                let selection = agent
                    .inference
                    .as_ref()
                    .ok_or(ConfigError("every agent requires model choices"))?;
                if selection.models.is_empty()
                    || selection.models.len() > 32
                    || !selection.models.contains_key(&selection.default)
                {
                    return Err(ConfigError("invalid default model choice"));
                }
                for (name, model) in &selection.models {
                    if !super::validation::SLUG.is_match(name) || !model.api.supported(harness) {
                        return Err(ConfigError("invalid native model choice"));
                    }
                    model.connection.validate(&model.provider, harness)?;
                    model.tuning.validate(harness)?;
                }
            }
            let selection = self
                .agents
                .iter()
                .min_by_key(|agent| &agent.name)
                .unwrap()
                .inference
                .as_ref()
                .unwrap();
            let primary = &selection.models[&selection.default];
            if primary.provider != self.provider
                || primary.connection != self.connection
                || primary.api != self.api
                || primary.tuning != self.tuning
            {
                return Err(ConfigError(
                    "runtime inference envelope differs from the canonical agent selection",
                ));
            }
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
    fn runtime_model(
        &self,
        harness: &str,
        provider: &InferenceProvider,
        route: &Route,
    ) -> Result<RuntimeModel, ConfigError> {
        let connection = self.provider_connection(provider)?;
        let profile = crate::openshell::inference_profile(
            &self.provider_key(provider),
            &connection.endpoint,
            &provider.provider,
            provider.authenticated(),
        )
        .map_err(|_| ConfigError("invalid native inference profile"))?;
        Ok(RuntimeModel {
            provider: self.provider_key(provider),
            connection: RuntimeConnection {
                provider: provider.provider.clone(),
                model: (harness != "pi").then(|| route.overrides.model.clone()),
                base_url: connection.endpoint,
                api_key_env: profile
                    .credentials
                    .first()
                    .map(|credential| credential.name.clone())
                    .unwrap_or_else(|| "NEMOCLAW_ANONYMOUS_API_KEY".into()),
            },
            api: provider.api.unwrap_or(InferenceApi::for_harness(harness)),
            tuning: route.overrides.tuning.clone(),
        })
    }

    pub(crate) fn sandbox_runtime_settings(
        &self,
        sandbox: &Sandbox,
    ) -> Result<SandboxRuntimeSettings, ConfigError> {
        let harness = self.sandbox_harness(sandbox)?;
        let mut resolved = sandbox
            .agents
            .iter()
            .map(|agent| {
                let (inference, scope) = self.scoped_inference(agent)?;
                let models = inference
                    .routes
                    .iter()
                    .map(|route| {
                        let provider = self.route_provider(route, scope)?;
                        Ok((
                            route.name.clone(),
                            self.runtime_model(&harness.kind, provider, route)?,
                        ))
                    })
                    .collect::<Result<_, ConfigError>>()?;
                Ok(ResolvedAgent {
                    agent,
                    inference,
                    models,
                })
            })
            .collect::<Result<Vec<_>, ConfigError>>()?;
        resolved.sort_by_key(|resolved| &resolved.agent.name);
        let first = resolved
            .first()
            .ok_or(ConfigError("at least one agent is required"))?;
        let primary = first.models[first.inference.default_route()?.name.as_str()].clone();
        let choices = harness.kind == "openclaw"
            || resolved
                .iter()
                .any(|agent| agent.models.len() > 1 || agent.inference != first.inference);
        let web_search = self.web_search(sandbox)?;
        let roster = choices
            || web_search.is_some()
            || resolved.len() > 1
            || resolved.iter().any(|agent| agent.agent.tools.is_some());
        let auth = first.agent.auth.as_ref().map(|auth| RuntimeAuth {
            method: auth.method.clone(),
            provider_ref: primary.provider.clone(),
        });
        let agents = if roster {
            resolved
                .into_iter()
                .map(|resolved| {
                    Ok(RuntimeAgent {
                        name: resolved.agent.name.clone(),
                        tools: resolved.agent.tools.clone(),
                        inference: if choices {
                            Some(RuntimeAgentInference {
                                default: resolved.inference.default_route()?.name.clone(),
                                models: resolved.models,
                            })
                        } else {
                            None
                        },
                    })
                })
                .collect::<Result<_, ConfigError>>()?
        } else {
            Vec::new()
        };
        Ok(SandboxRuntimeSettings {
            provider: primary.provider,
            connection: primary.connection,
            api: primary.api,
            tuning: primary.tuning,
            agents,
            web_search,
            observability: harness.observability.clone(),
            execution: harness.execution.clone(),
            interfaces: harness.interfaces.clone(),
            auth,
        })
    }
}

// Borrow authored definitions and resolve routes once while lowering settings.
// The exported document keeps the original inline/reference forms.
struct ResolvedAgent<'a> {
    agent: &'a Agent,
    inference: &'a Inference,
    models: std::collections::BTreeMap<String, RuntimeModel>,
}
