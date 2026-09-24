// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{HarnessKind, InferenceApi, InferenceProviderKind};

use crate::{Answers, ApiChoice, HarnessChoice, ProviderPreset, RuntimeChoice};

pub(crate) const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

/// An offered guided-authoring combination and its offline defaults.
#[derive(Clone, Debug)]
pub struct Scenario {
    pub(crate) harness: HarnessChoice,
    pub(crate) runtime: RuntimeChoice,
    pub(crate) inference: ProviderPreset,
    pub(crate) api: ApiChoice,
    pub(crate) provider_kind: InferenceProviderKind,
    pub(crate) provider_api: Option<InferenceApi>,
    pub(crate) provider_name: &'static str,
    pub(crate) endpoint: &'static str,
    pub(crate) credential_env: &'static str,
    pub(crate) custom_endpoint: bool,
    pub(crate) custom_model: bool,
    pub(crate) default_model: Option<&'static str>,
}

/// Fabric-derived harness choices intersected with local projection constraints.
#[derive(Clone, Debug)]
pub struct Capabilities {
    scenarios: Vec<Scenario>,
}

impl Scenario {
    pub fn harness(&self) -> HarnessChoice {
        self.harness
    }
    pub fn runtime(&self) -> RuntimeChoice {
        self.runtime
    }
    pub fn inference(&self) -> ProviderPreset {
        self.inference
    }
    pub fn api(&self) -> ApiChoice {
        self.api
    }
    /// Offline default, not a provider catalog or an allowlist.
    pub fn default_model(&self) -> Option<&str> {
        self.default_model
    }
    pub fn accepts_custom_model(&self) -> bool {
        self.custom_model
    }
    pub fn accepts_custom_endpoint(&self) -> bool {
        self.custom_endpoint
    }
    pub fn suggested_endpoint(&self) -> &str {
        self.endpoint
    }
}

impl Capabilities {
    /// Lists native V1 authoring presets. Earlier implementations may guide this
    /// catalog, but no earlier-product data is loaded at runtime.
    pub fn scenarios(&self) -> &[Scenario] {
        &self.scenarios
    }

    pub fn available() -> Self {
        Self::from_catalog(&nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled())
    }

    /// Consume canonical Fabric metadata; ordering is presentation policy.
    pub fn from_catalog(catalog: &nemoclaw_sdk::fabric_catalog::FabricCatalog) -> Self {
        let mut harnesses: Vec<HarnessKind> = catalog
            .adapters
            .iter()
            .filter_map(|adapter| adapter.harness.parse().ok())
            .collect();
        harnesses.sort_by_key(|harness| match harness {
            HarnessKind::OpenClaw => 0,
            HarnessKind::Hermes => 1,
            HarnessKind::DeepAgents => 2,
            HarnessKind::Pi => 3,
            _ => 4,
        });
        Self::from_harnesses(harnesses)
    }

    /// Intersect Fabric observations with the configurations this frontend can
    /// project. An empty observation remains empty, never an offline fallback.
    pub fn from_harnesses(harnesses: impl IntoIterator<Item = HarnessKind>) -> Self {
        let mut scenarios = Vec::new();
        let mut seen = Vec::new();
        for harness in harnesses {
            if seen.contains(&harness)
                || !matches!(
                    harness,
                    HarnessKind::OpenClaw
                        | HarnessKind::Hermes
                        | HarnessKind::DeepAgents
                        | HarnessKind::Pi
                )
            {
                continue;
            }
            seen.push(harness);
            for runtime in [RuntimeChoice::Docker, RuntimeChoice::Podman] {
                for inference in [
                    ProviderPreset::NvidiaEndpoints,
                    ProviderPreset::OpenRouter,
                    ProviderPreset::OpenAi,
                    ProviderPreset::OpenAiCompatible,
                    ProviderPreset::Anthropic,
                    ProviderPreset::AnthropicCompatible,
                    ProviderPreset::Gemini,
                    ProviderPreset::HermesProvider,
                ] {
                    append_provider_scenarios(&mut scenarios, harness, runtime, inference);
                }
            }
        }
        Self { scenarios }
    }

    pub(crate) fn scenario(
        &self,
        harness: HarnessChoice,
        runtime: RuntimeChoice,
        inference: ProviderPreset,
        api: ApiChoice,
    ) -> Option<&Scenario> {
        self.scenarios.iter().find(|scenario| {
            scenario.harness == harness
                && scenario.runtime == runtime
                && scenario.inference == inference
                && scenario.api == api
        })
    }

    pub(crate) fn unavailable_field(&self, answers: &Answers) -> &'static str {
        if !self
            .scenarios
            .iter()
            .any(|row| row.harness == answers.harness)
        {
            return "harness";
        }
        if !self
            .scenarios
            .iter()
            .any(|row| row.harness == answers.harness && row.runtime == answers.runtime)
        {
            return "runtime";
        }
        if !self.scenarios.iter().any(|row| {
            row.harness == answers.harness
                && row.runtime == answers.runtime
                && row.inference == answers.inference
        }) {
            return "inference";
        }
        "api"
    }
}

fn append_provider_scenarios(
    scenarios: &mut Vec<Scenario>,
    harness: HarnessKind,
    runtime: RuntimeChoice,
    inference: ProviderPreset,
) {
    if inference == ProviderPreset::HermesProvider && harness != HarnessKind::Hermes {
        return;
    }
    if inference == ProviderPreset::Anthropic
        && !matches!(harness, HarnessKind::OpenClaw | HarnessKind::Hermes)
    {
        return;
    }

    let anthropic_native = matches!(
        inference,
        ProviderPreset::Anthropic | ProviderPreset::AnthropicCompatible
    ) && matches!(harness, HarnessKind::OpenClaw | HarnessKind::Hermes);
    let apis: &[InferenceApi] = if anthropic_native {
        &[InferenceApi::AnthropicMessages]
    } else if matches!(harness, HarnessKind::OpenClaw | HarnessKind::Hermes) {
        &[
            InferenceApi::OpenaiCompletions,
            InferenceApi::OpenaiResponses,
        ]
    } else {
        &[InferenceApi::OpenaiCompletions]
    };

    let (provider_kind, name, endpoint, credential, custom_endpoint, custom_model, default_model) =
        provider_profile(inference, anthropic_native);
    for api in apis {
        scenarios.push(Scenario {
            harness,
            runtime,
            inference,
            api: *api,
            provider_kind,
            provider_api: (harness != HarnessKind::Pi).then_some(*api),
            provider_name: name,
            endpoint,
            credential_env: credential,
            custom_endpoint,
            custom_model,
            default_model,
        });
    }
}

type ProviderProfile = (
    InferenceProviderKind,
    &'static str,
    &'static str,
    &'static str,
    bool,
    bool,
    Option<&'static str>,
);

fn provider_profile(inference: ProviderPreset, anthropic_native: bool) -> ProviderProfile {
    match inference {
        ProviderPreset::NvidiaEndpoints => (
            InferenceProviderKind::Openai,
            "nvidia-prod",
            "https://integrate.api.nvidia.com/v1",
            "NVIDIA_INFERENCE_API_KEY",
            false,
            true,
            Some(NVIDIA_MODEL),
        ),
        ProviderPreset::OpenRouter => (
            InferenceProviderKind::Openai,
            "openrouter",
            "https://openrouter.ai/api/v1",
            "OPENROUTER_API_KEY",
            false,
            true,
            Some(NVIDIA_MODEL),
        ),
        ProviderPreset::OpenAi => (
            InferenceProviderKind::Openai,
            "openai-api",
            "https://api.openai.com/v1",
            "OPENAI_API_KEY",
            false,
            true,
            Some("gpt-5.4"),
        ),
        ProviderPreset::OpenAiCompatible => (
            InferenceProviderKind::Openai,
            "compatible-endpoint",
            "https://inference.example.com/v1",
            "COMPATIBLE_API_KEY",
            true,
            true,
            None,
        ),
        ProviderPreset::Anthropic => (
            InferenceProviderKind::Anthropic,
            "anthropic-prod",
            "https://api.anthropic.com",
            "ANTHROPIC_API_KEY",
            false,
            true,
            Some("claude-sonnet-4-6"),
        ),
        ProviderPreset::AnthropicCompatible if anthropic_native => (
            InferenceProviderKind::Anthropic,
            "compatible-anthropic-endpoint",
            "https://anthropic.example.com",
            "COMPATIBLE_ANTHROPIC_API_KEY",
            true,
            true,
            None,
        ),
        ProviderPreset::AnthropicCompatible => (
            InferenceProviderKind::Openai,
            "compatible-anthropic-endpoint",
            "https://anthropic.example.com/v1",
            "COMPATIBLE_ANTHROPIC_API_KEY",
            true,
            true,
            None,
        ),
        ProviderPreset::Gemini => (
            InferenceProviderKind::Openai,
            "gemini-api",
            "https://generativelanguage.googleapis.com/v1beta/openai/",
            "GEMINI_API_KEY",
            false,
            true,
            Some("gemini-3.6-flash"),
        ),
        ProviderPreset::HermesProvider => (
            InferenceProviderKind::Openai,
            "hermes-provider",
            "https://inference-api.nousresearch.com/v1",
            "OPENAI_API_KEY",
            false,
            true,
            Some("moonshotai/kimi-k2.6"),
        ),
    }
}
