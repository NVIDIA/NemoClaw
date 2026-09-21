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
/// Optional model limits and OpenClaw reasoning defaults. Omission preserves native defaults.
pub struct RouteTuning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32", range(min = 1, max = 4194304))]
    /// Model context capacity in tokens. Does not resize the inference server.
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32", range(min = 1, max = 1000000000))]
    /// Maximum output tokens for OpenClaw, Deep Agents, mini-swe-agent, or remote-agent.
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
        let supported = harness == "openclaw"
            || (matches!(harness, "deepagents" | "mini-swe-agent" | "remote-agent")
                && self.context_window.is_none()
                && self.reasoning.is_none()
                && self.reasoning_effort.is_none())
            || self == &Self::default();
        if !supported
            || self
                .context_window
                .is_some_and(|n| !(1..=4194304).contains(&n))
            || self
                .max_tokens
                .is_some_and(|n| !(1..=1000000000).contains(&n))
        {
            return Err(ConfigError::new(
                "route tuning requires a supported harness, option, and token bounds",
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
/// Native read-only tool restriction or OpenClaw discovery mode. These forms are mutually exclusive.
pub enum AgentTools {
    /// Expose only the read tool, independently of the gateway's discovery mode.
    ReadOnly {
        /// Exactly the read tool. Empty lists, wildcards, and other tool names are rejected.
        allow: [AllowedTool; 1],
    },
    /// Select the gateway's tool discovery mode without granting additional tools.
    Disclosure {
        /// Progressive uses structured tool search; direct exposes tools directly. Omission means progressive.
        disclosure: ToolDisclosure,
    },
}
impl AgentTools {
    pub(crate) fn validate(&self, harness: &str) -> Result<(), ConfigError> {
        if harness == "openclaw"
            || (matches!(harness, "deepagents" | "pi") && matches!(self, Self::ReadOnly { .. }))
        {
            Ok(())
        } else {
            Err(ConfigError::new(
                "read-only tools require OpenClaw, Deep Agents, or Pi; disclosure requires OpenClaw",
            ))
        }
    }
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
/// Tool supported by the native read-only policy.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi: Option<Overrides>,
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
        let expected_credential =
            if crate::services::installers::ollama::reserved_proxy_port(&self.base_url).is_some() {
                crate::openshell::inference_credential_name(
                    provider,
                    &self.provider,
                    self.api_key_env != "NEMOCLAW_ANONYMOUS_API_KEY",
                )
                .map_err(|_| ConfigError::new("invalid native inference connection"))?
            } else {
                super::validate_endpoint(&self.base_url, false)?;
                let profile = crate::openshell::inference_profile(
                    provider,
                    &self.base_url,
                    &self.provider,
                    self.api_key_env != "NEMOCLAW_ANONYMOUS_API_KEY",
                )
                .map_err(|_| ConfigError::new("invalid native inference connection"))?;
                profile
                    .credentials
                    .first()
                    .map(|credential| credential.name.clone())
                    .unwrap_or_else(|| "NEMOCLAW_ANONYMOUS_API_KEY".into())
            };
        if expected_credential != self.api_key_env {
            return Err(ConfigError::new(
                "inference credential does not match its provider",
            ));
        }
        if self.model.is_none() != (harness == "pi")
            || self
                .model
                .as_deref()
                .is_some_and(|model| !super::validation::valid_model(model))
        {
            return Err(ConfigError::new("invalid native inference model"));
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
        }
        if let Some(execution) = &self.execution {
            execution.validate(harness)?;
        }
        if let Some(interfaces) = &self.interfaces {
            interfaces.validate(harness)?;
        }
        for agent in &self.agents {
            if let Some(tools) = &agent.tools {
                tools.validate(harness)?;
            }
        }
        if !self.agents.is_empty()
            && (!matches!(harness, "openclaw" | "pi" | "deepagents")
                || self.agents.len() != 1
                || self
                    .agents
                    .iter()
                    .any(|a| !super::validation::SLUG.is_match(&a.name)))
        {
            return Err(ConfigError::new("invalid harness agent roster"));
        }
        if let Some(selection) = self
            .agents
            .first()
            .and_then(|agent| agent.inference.as_ref())
        {
            if (harness == "deepagents" && selection.models.len() != 1)
                || selection.models.is_empty()
                || selection.models.len() > 32
                || !selection.models.contains_key(&selection.default)
            {
                return Err(ConfigError::new("invalid default model choice"));
            }
            for (name, model) in &selection.models {
                if !super::validation::SLUG.is_match(name) || !model.api.supported(harness) {
                    return Err(ConfigError::new("invalid native model choice"));
                }
                model.connection.validate(&model.provider, harness)?;
                model.tuning.validate(harness)?;
                if (harness == "pi") != model.pi.is_some()
                    || model
                        .pi
                        .as_ref()
                        .is_some_and(|pi| !super::validation::valid_model(&pi.model))
                {
                    return Err(ConfigError::new("invalid Pi model choice"));
                }
            }
            let primary = &selection.models[&selection.default];
            if primary.provider != self.provider
                || primary.connection != self.connection
                || primary.api != self.api
                || primary.tuning != self.tuning
            {
                return Err(ConfigError::new(
                    "runtime inference settings differ from the agent's default model settings",
                ));
            }
        }
        if !self.api.supported(harness)
            || self
                .auth
                .as_ref()
                .is_some_and(|a| harness != "hermes" || a.provider_ref.is_empty())
        {
            return Err(ConfigError::new("unsupported agent inference settings"));
        }
        Ok(())
    }
}
impl Document {
    fn runtime_model(
        &self,
        harness: &str,
        selected: &super::providers::SelectedProvider<'_>,
        route: &Route,
    ) -> Result<RuntimeModel, ConfigError> {
        let provider = selected.definition;
        let connection = self.provider_connection(provider)?;
        let profile = crate::openshell::inference_profile_with_destination(
            &selected.key,
            &connection.endpoint,
            &provider.provider,
            crate::services::provider_authenticated(self, provider)?,
            connection.destination_ip.as_deref(),
        )
        .map_err(|_| ConfigError::new("invalid native inference profile"))?;
        Ok(RuntimeModel {
            pi: (harness == "pi").then(|| route.overrides.clone()),
            provider: selected.key.clone(),
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
        let agent = &sandbox.agent;
        let selection = self.scoped_inference(sandbox)?;
        let inference = selection.inference;
        let models: std::collections::BTreeMap<_, _> = inference
            .routes
            .iter()
            .map(|route| {
                let provider = self.route_provider(route, &selection)?;
                Ok((
                    route.name.clone(),
                    self.runtime_model(&harness.kind, &provider, route)?,
                ))
            })
            .collect::<Result<_, ConfigError>>()?;
        let primary = models[inference.default_route()?.name.as_str()].clone();
        let choices = harness.kind == "openclaw"
            || (harness.kind == "pi" && agent.tools.is_some())
            || models.len() > 1;
        let web_search = self.web_search(sandbox)?;
        let auth = agent.auth.as_ref().map(|auth| RuntimeAuth {
            method: auth.method.clone(),
            provider_ref: primary.provider.clone(),
        });
        let agents = if choices || web_search.is_some() || agent.tools.is_some() {
            vec![RuntimeAgent {
                name: agent.name.clone(),
                tools: agent.tools.clone(),
                inference: if choices {
                    Some(RuntimeAgentInference {
                        default: inference.default_route()?.name.clone(),
                        models,
                    })
                } else {
                    None
                },
            }]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_resolution_uses_the_supplied_sandbox_scope_not_its_memory_address() {
        for scope in ["deployment", "sandbox", "inline"] {
            let mut document = Document::parse(
                include_bytes!("../../../../examples/fabric-openclaw.yaml").as_slice(),
            )
            .unwrap();
            if scope == "sandbox" {
                document.spec.sandboxes[0].inference_providers =
                    std::mem::take(&mut document.spec.inference_providers);
            }
            if scope == "inline" {
                let provider = document.spec.inference_providers.remove(0);
                let route = &mut document.spec.sandboxes[0]
                    .agent
                    .inference
                    .as_mut()
                    .unwrap()
                    .routes[0];
                route.provider_ref = None;
                route.provider = Some(provider);
            }
            let sandbox = document.spec.sandboxes[0].clone();
            let expected = document
                .sandbox_runtime_settings(&document.spec.sandboxes[0])
                .unwrap();
            assert_eq!(
                document.sandbox_runtime_settings(&sandbox).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn mismatched_runtime_settings_identify_the_agents_default_model() {
        let document =
            Document::parse(include_bytes!("../../../../examples/fabric-openclaw.yaml").as_slice())
                .unwrap();
        let generations = ["workspace", "provider", "sandbox"]
            .map(|kind| (kind.into(), "a".repeat(32)))
            .into();
        let targets = crate::compile::targets(&document, &generations).unwrap();
        let sandbox = targets
            .iter()
            .find(|target| target.kind == "sandbox")
            .unwrap();
        let settings: SandboxRuntimeSettings =
            serde_json::from_str(&sandbox.values["inference_json"]).unwrap();
        settings.validate("openclaw").unwrap();
        let mut changed = settings;
        changed.connection.model = Some("different-model".into());
        assert_eq!(
            changed.validate("openclaw").unwrap_err().to_string(),
            "runtime inference settings differ from the agent's default model settings"
        );
    }
}
