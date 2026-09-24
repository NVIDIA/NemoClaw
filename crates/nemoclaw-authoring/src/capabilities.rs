// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::ProviderPreset;
use nemoclaw_sdk::config::{HarnessKind, InferenceApi, InferenceProviderKind};

pub(crate) const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

/// Canonical adapter identities and schemas for presenting authoring questions.
/// This is not a compatibility registry: Fabric plans the selected configuration.
#[derive(Clone, Debug)]
pub struct Capabilities {
    harnesses: Vec<HarnessKind>,
    pub(crate) config_schemas: std::collections::BTreeMap<String, serde_json::Value>,
    pub(crate) model_schemas: std::collections::BTreeMap<String, serde_json::Value>,
    pub(crate) targets: Vec<serde_json::Value>,
    pub(crate) schemas: std::collections::BTreeMap<String, Vec<(String, serde_json::Value)>>,
}

impl Capabilities {
    pub fn available() -> Self {
        Self::from_catalog(&nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled())
    }

    pub fn from_catalog(catalog: &nemoclaw_sdk::fabric_catalog::FabricCatalog) -> Self {
        let mut capabilities = Self::from_harnesses(
            catalog
                .adapters
                .iter()
                .filter_map(|adapter| adapter.descriptor["adapter_id"].as_str()?.parse().ok()),
        );
        capabilities.targets = catalog.targets.clone();
        for adapter in &catalog.adapters {
            let Some(id) = adapter.descriptor["adapter_id"].as_str() else {
                continue;
            };
            if let Some(schema) = adapter
                .descriptor
                .get("model_schema")
                .filter(|schema| !schema.is_null())
            {
                capabilities.model_schemas.insert(id.into(), schema.clone());
            }
            if let Some(schema) = adapter.descriptor["config"].get("schema") {
                capabilities
                    .config_schemas
                    .insert(id.into(), schema.clone());
            }
            if let Some(schema) = adapter
                .descriptor
                .get("settings_schema")
                .filter(|schema| !schema.is_null())
            {
                capabilities
                    .schemas
                    .entry(id.into())
                    .or_default()
                    .push((id.into(), schema.clone()));
            }
        }
        capabilities
    }

    pub fn from_harnesses(harnesses: impl IntoIterator<Item = HarnessKind>) -> Self {
        let mut harnesses: Vec<_> = harnesses.into_iter().collect();
        harnesses.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        harnesses.dedup();
        Self {
            harnesses,
            schemas: Default::default(),
            config_schemas: Default::default(),
            targets: Vec::new(),
            model_schemas: Default::default(),
        }
    }

    pub fn harnesses(&self) -> &[HarnessKind] {
        &self.harnesses
    }

    /// Validate that the draft has a lossless guided view. The draft's current
    /// value remains in that view even when discovery no longer advertises it.
    pub fn preserving_draft(&self, draft: &crate::Draft) -> Result<Self, crate::Diagnostics> {
        draft.guided_answers(self)?;
        Ok(self.clone())
    }
}

/// Endpoint defaults are presentation presets, not claims of adapter support.
pub(crate) struct ProviderProfile {
    pub kind: InferenceProviderKind,
    pub name: &'static str,
    pub endpoint: &'static str,
    pub credential: &'static str,
    pub custom_endpoint: bool,
    pub default_model: Option<&'static str>,
}

impl ProviderPreset {
    pub const ALL: [Self; 8] = [
        Self::NvidiaEndpoints,
        Self::OpenRouter,
        Self::OpenAi,
        Self::OpenAiCompatible,
        Self::Anthropic,
        Self::AnthropicCompatible,
        Self::Gemini,
        Self::Nous,
    ];

    pub(crate) fn profile(self) -> ProviderProfile {
        provider_profile(self)
    }

    pub fn apis(self) -> &'static [InferenceApi] {
        match self.profile().kind {
            InferenceProviderKind::Anthropic => &[InferenceApi::AnthropicMessages],
            InferenceProviderKind::Openai => &[
                InferenceApi::OpenaiCompletions,
                InferenceApi::OpenaiResponses,
            ],
        }
    }
}

fn provider_profile(inference: ProviderPreset) -> ProviderProfile {
    match inference {
        ProviderPreset::NvidiaEndpoints => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            name: "nvidia-prod",
            endpoint: "https://integrate.api.nvidia.com/v1",
            credential: "NVIDIA_INFERENCE_API_KEY",
            custom_endpoint: false,
            default_model: Some(NVIDIA_MODEL),
        },
        ProviderPreset::OpenRouter => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            name: "openrouter",
            endpoint: "https://openrouter.ai/api/v1",
            credential: "OPENROUTER_API_KEY",
            custom_endpoint: false,
            default_model: Some(NVIDIA_MODEL),
        },
        ProviderPreset::OpenAi => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            name: "openai-api",
            endpoint: "https://api.openai.com/v1",
            credential: "OPENAI_API_KEY",
            custom_endpoint: false,
            default_model: Some("gpt-5.4"),
        },
        ProviderPreset::OpenAiCompatible => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            name: "compatible-endpoint",
            endpoint: "https://inference.example.com/v1",
            credential: "COMPATIBLE_API_KEY",
            custom_endpoint: true,
            default_model: None,
        },
        ProviderPreset::Anthropic => ProviderProfile {
            kind: InferenceProviderKind::Anthropic,
            name: "anthropic-prod",
            endpoint: "https://api.anthropic.com",
            credential: "ANTHROPIC_API_KEY",
            custom_endpoint: false,
            default_model: Some("claude-sonnet-4-6"),
        },
        ProviderPreset::AnthropicCompatible => ProviderProfile {
            kind: InferenceProviderKind::Anthropic,
            name: "compatible-anthropic-endpoint",
            endpoint: "https://anthropic.example.com",
            credential: "COMPATIBLE_ANTHROPIC_API_KEY",
            custom_endpoint: true,
            default_model: None,
        },
        ProviderPreset::Gemini => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            name: "gemini-api",
            endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
            credential: "GEMINI_API_KEY",
            custom_endpoint: false,
            default_model: Some("gemini-3.6-flash"),
        },
        ProviderPreset::Nous => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            name: "nous-api",
            endpoint: "https://inference-api.nousresearch.com/v1",
            credential: "OPENAI_API_KEY",
            custom_endpoint: false,
            default_model: Some("moonshotai/kimi-k2.6"),
        },
    }
}
