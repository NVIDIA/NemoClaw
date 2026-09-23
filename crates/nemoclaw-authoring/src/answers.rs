// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::capabilities::NVIDIA_MODEL;
use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceApi};

pub type HarnessChoice = HarnessKind;
pub type RuntimeChoice = ComputeDriver;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
/// Branded endpoint preset offered by guided authoring.
///
/// This is not a document-model provider kind. Each choice projects to the
/// SDK's generic provider kind, API, endpoint, and credential reference.
pub enum ProviderPreset {
    NvidiaEndpoints,
    OpenRouter,
    OpenAi,
    OpenAiCompatible,
    Anthropic,
    AnthropicCompatible,
    Gemini,
    HermesProvider,
}

impl ProviderPreset {
    pub const fn label(self) -> &'static str {
        match self {
            Self::NvidiaEndpoints => "NVIDIA Endpoints",
            Self::OpenRouter => "OpenRouter",
            Self::OpenAi => "OpenAI",
            Self::OpenAiCompatible => "Other OpenAI-compatible endpoint",
            Self::Anthropic => "Anthropic",
            Self::AnthropicCompatible => "Other Anthropic-compatible endpoint",
            Self::Gemini => "Google Gemini",
            Self::HermesProvider => "Hermes Provider (Nous)",
        }
    }
}

pub type ApiChoice = InferenceApi;

/// Inputs for one curated guided-onboarding projection.
///
/// This is a frontend view, not a second desired-state schema. [`crate::Draft`]
/// owns the SDK's complete [`nemoclaw_sdk::config::Document`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answers {
    pub deployment_name: String,
    pub sandbox_name: String,
    pub agent_name: String,
    pub harness: HarnessChoice,
    pub runtime: RuntimeChoice,
    pub inference: ProviderPreset,
    pub api: ApiChoice,
    pub provider_name: String,
    pub endpoint: String,
    pub model: String,
    pub credential_env: String,
}

/// Optional replacements for defaults, independent of how a frontend collects them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AnswerOverrides {
    pub deployment_name: Option<String>,
    pub sandbox_name: Option<String>,
    pub agent_name: Option<String>,
    pub harness: Option<HarnessChoice>,
    pub runtime: Option<RuntimeChoice>,
    pub inference: Option<ProviderPreset>,
    pub api: Option<ApiChoice>,
    pub provider_name: Option<String>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub credential_env: Option<String>,
}

impl Answers {
    /// Returns the CLI's OpenClaw, Docker, and NVIDIA-hosted inference preset.
    pub fn onboarding_defaults() -> Self {
        Self {
            deployment_name: "openclaw-nvidia-hosted".into(),
            sandbox_name: "assistant".into(),
            agent_name: "primary".into(),
            harness: HarnessChoice::OpenClaw,
            runtime: RuntimeChoice::Docker,
            inference: ProviderPreset::NvidiaEndpoints,
            api: ApiChoice::OpenaiCompletions,
            provider_name: "nvidia-prod".into(),
            endpoint: "https://integrate.api.nvidia.com/v1".into(),
            model: NVIDIA_MODEL.into(),
            credential_env: "NVIDIA_INFERENCE_API_KEY".into(),
        }
    }

    /// Replaces supplied fields without validating; projection checks the result.
    pub fn with_overrides(mut self, inputs: AnswerOverrides) -> Self {
        self.deployment_name = inputs.deployment_name.unwrap_or(self.deployment_name);
        self.sandbox_name = inputs.sandbox_name.unwrap_or(self.sandbox_name);
        self.agent_name = inputs.agent_name.unwrap_or(self.agent_name);
        self.harness = inputs.harness.unwrap_or(self.harness);
        self.runtime = inputs.runtime.unwrap_or(self.runtime);
        self.inference = inputs.inference.unwrap_or(self.inference);
        self.api = inputs.api.unwrap_or(self.api);
        self.provider_name = inputs.provider_name.unwrap_or(self.provider_name);
        self.endpoint = inputs.endpoint.unwrap_or(self.endpoint);
        self.model = inputs.model.unwrap_or(self.model);
        self.credential_env = inputs.credential_env.unwrap_or(self.credential_env);
        self
    }

    /// Adopts one advertised scenario while preserving user-facing identity.
    pub fn for_scenario(mut self, scenario: &crate::Scenario) -> Self {
        self.harness = scenario.harness();
        self.runtime = scenario.runtime();
        self.inference = scenario.inference();
        self.api = scenario.api();
        self.provider_name = scenario.provider_name.into();
        self.endpoint = scenario.endpoint.into();
        self.credential_env = scenario.credential_env.into();
        if let Some(model) = scenario.default_model() {
            self.model = model.into();
        }
        self
    }
}
