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
        self.harness.clone()
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
        harnesses.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        let mut capabilities = Self::from_harnesses(harnesses);
        capabilities.scenarios.retain(|scenario| {
            use nemoclaw_sdk::fabric_capabilities::{
                FabricRequirements, Support, api_name, assess_fabric,
            };
            assess_fabric(
                catalog,
                &FabricRequirements {
                    harness: scenario.harness.as_str().into(),
                    api: Some(api_name(scenario.api).into()),
                    ..Default::default()
                },
            )
            .status
                != Support::Unsupported
        });
        capabilities
    }

    /// Intersect Fabric observations with the configurations this frontend can
    /// project. An empty observation remains empty, never an offline fallback.
    pub fn from_harnesses(harnesses: impl IntoIterator<Item = HarnessKind>) -> Self {
        let mut scenarios = Vec::new();
        let mut seen = Vec::new();
        for harness in harnesses {
            if seen.contains(&harness) {
                continue;
            }
            seen.push(harness.clone());
            for runtime in [RuntimeChoice::Docker, RuntimeChoice::Podman] {
                for inference in [
                    ProviderPreset::NvidiaEndpoints,
                    ProviderPreset::OpenRouter,
                    ProviderPreset::OpenAi,
                    ProviderPreset::OpenAiCompatible,
                    ProviderPreset::Anthropic,
                    ProviderPreset::AnthropicCompatible,
                    ProviderPreset::Gemini,
                    ProviderPreset::Nous,
                ] {
                    append_provider_scenarios(&mut scenarios, harness.clone(), runtime, inference);
                }
            }
        }
        Self { scenarios }
    }

    /// Retain only the document's selected scenario so an unobserved or changed
    /// catalog cannot prevent reopening intent. This does not establish support.
    pub fn preserving_draft(&self, draft: &crate::Draft) -> Result<Self, crate::Diagnostics> {
        let document = draft.document();
        let [sandbox] = document.spec.sandboxes.as_slice() else {
            return Err(crate::diagnostics::diagnostic(
                "document",
                "guided editing requires one onboarding sandbox",
            ));
        };
        let harness = document
            .sandbox_harness(sandbox)
            .map_err(|error| crate::diagnostics::diagnostic("document", &error.to_string()))?
            .kind
            .clone();
        let mut candidates = self.clone();
        candidates.extend(Self::from_harnesses([harness]).scenarios);
        // Reuse the projection's full roundtrip check before retaining any scenario.
        let answers = draft.guided_answers(&candidates)?;
        let scenario = candidates
            .scenario(
                answers.harness,
                answers.runtime,
                answers.inference,
                answers.api,
            )
            .expect("guided answers identify a representable scenario")
            .clone();
        let mut result = self.clone();
        result.extend([scenario]);
        Ok(result)
    }

    /// Add observed scenarios without losing the draft's existing representation.
    /// Consumers still scope offered choices to the catalog's image and engine.
    pub fn with_catalog(&self, catalog: &nemoclaw_sdk::fabric_catalog::FabricCatalog) -> Self {
        let mut result = self.clone();
        result.extend(Self::from_catalog(catalog).scenarios);
        result
    }

    fn extend(&mut self, scenarios: impl IntoIterator<Item = Scenario>) {
        for scenario in scenarios {
            if self
                .scenario(
                    scenario.harness.clone(),
                    scenario.runtime,
                    scenario.inference,
                    scenario.api,
                )
                .is_none()
            {
                self.scenarios.push(scenario);
            }
        }
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
    let apis: &[InferenceApi] = match inference {
        ProviderPreset::Anthropic | ProviderPreset::AnthropicCompatible => {
            &[InferenceApi::AnthropicMessages]
        }
        _ => &[
            InferenceApi::OpenaiCompletions,
            InferenceApi::OpenaiResponses,
        ],
    };
    let (provider_kind, name, endpoint, credential, custom_endpoint, custom_model, default_model) =
        provider_profile(inference);
    for api in apis.iter().copied().filter(|api| {
        api.provider_override(harness.clone()).is_some()
            || *api == InferenceApi::for_harness(harness.clone())
    }) {
        scenarios.push(Scenario {
            harness: harness.clone(),
            runtime,
            inference,
            api,
            provider_kind,
            provider_api: api.provider_override(harness.clone()),
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

fn provider_profile(inference: ProviderPreset) -> ProviderProfile {
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
        ProviderPreset::AnthropicCompatible => (
            InferenceProviderKind::Anthropic,
            "compatible-anthropic-endpoint",
            "https://anthropic.example.com",
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
        ProviderPreset::Nous => (
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
