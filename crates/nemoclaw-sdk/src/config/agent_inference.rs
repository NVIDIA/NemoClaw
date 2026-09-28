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
    /// Generic protocol default when no explicit API is authored.
    pub fn for_provider(provider: InferenceProviderKind) -> Self {
        match provider {
            InferenceProviderKind::Anthropic => Self::AnthropicMessages,
            InferenceProviderKind::Openai => Self::OpenaiCompletions,
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Optional public model limits; Fabric owns native capability validation.
pub struct RouteTuning {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(default, with = "u32", range(min = 1, max = 4294967295u32))]
    /// Maximum output tokens requested from the native adapter.
    pub max_tokens: Option<u32>,
}
impl RouteTuning {
    pub fn validate(&self) -> Result<(), ConfigError> {
        super::schema::validate_tuning(self)?;
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "kebab-case")]
/// Authentication method supported through the OpenShell provider.
pub enum AuthMethod {
    ApiKey,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Authenticate inference using the primary route's credential-bearing provider.
pub struct AgentAuth {
    /// API-key authentication. Interactive login is not supported.
    pub method: AuthMethod,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
/// Explicit native tool identifiers forwarded to Fabric.
pub struct AgentTools {
    /// Native tool identifiers. Fabric validates availability and semantics.
    #[schemars(length(min = 1, max = 128))]
    pub allow: Vec<String>,
}
impl AgentTools {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        super::schema::validate_definition("AgentTools", self)
    }
}
