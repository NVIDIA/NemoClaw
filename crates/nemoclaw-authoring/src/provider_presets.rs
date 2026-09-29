// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{InferenceApi, InferenceProviderKind};

pub(crate) const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

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
    Nous,
}

impl ProviderPreset {
    pub const fn id(self) -> &'static str {
        match self {
            Self::NvidiaEndpoints => "nvidia-endpoints",
            Self::OpenRouter => "openrouter",
            Self::OpenAi => "openai",
            Self::OpenAiCompatible => "openai-compatible",
            Self::Anthropic => "anthropic",
            Self::AnthropicCompatible => "anthropic-compatible",
            Self::Gemini => "gemini",
            Self::Nous => "nous",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|preset| preset.id() == id)
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::NvidiaEndpoints => "NVIDIA Endpoints",
            Self::OpenRouter => "OpenRouter",
            Self::OpenAi => "OpenAI",
            Self::OpenAiCompatible => "Other OpenAI-compatible endpoint",
            Self::Anthropic => "Anthropic",
            Self::AnthropicCompatible => "Other Anthropic-compatible endpoint",
            Self::Gemini => "Google Gemini",
            Self::Nous => "Nous Research",
        }
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
            credential: "NVIDIA_API_KEY",
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
