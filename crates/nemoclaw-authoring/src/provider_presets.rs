// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::{InferenceApi, InferenceProviderKind};

pub(crate) const NVIDIA_MODEL: &str = "nvidia/nemotron-3.5-super-vl-120b-a12b";

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
    pub endpoint: &'static str,
    pub credential: &'static str,
    pub custom_endpoint: bool,
    pub default_model: Option<&'static str>,
    /// Page where the provider issues API keys. Compatible endpoints have none.
    pub key_url: Option<&'static str>,
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

    /// Page where a user gets an API key for this preset, if the provider has one.
    pub fn key_url(self) -> Option<&'static str> {
        self.profile().key_url
    }

    /// The hosted preset whose API key lives in `credential`.
    pub fn for_credential_reference(credential: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|preset| {
            let profile = preset.profile();
            profile.credential == credential && profile.key_url.is_some()
        })
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

    /// Curated onboarding suggestions, not an exhaustive list or a live
    /// observation of access, adapter compatibility, or inference support.
    /// Generic endpoints have no vendor catalog.
    pub fn recommended_models(self) -> &'static [&'static str] {
        // Adapted from main at 4088879ac07445d4b89fc02c05adcd5fe213cf9d,
        // src/lib/inference/{config,model-prompts}.ts. Keep the v1 preset
        // defaults first; catalog updates belong to source review, not discovery.
        match self {
            Self::NvidiaEndpoints => &[NVIDIA_MODEL, "nvidia/nemotron-3-ultra-550b-a55b"],
            Self::OpenRouter => &[
                NVIDIA_MODEL,
                "nvidia/nemotron-3-ultra-550b-a55b",
                "minimaxai/minimax-m3",
            ],
            Self::OpenAi => &[
                "gpt-5.4",
                "gpt-5.4-mini",
                "gpt-5.4-nano",
                "gpt-5.4-pro-2026-03-05",
            ],
            Self::Anthropic => &["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"],
            Self::Gemini => &[
                "gemini-3.6-flash",
                "gemini-3.1-pro-preview",
                "gemini-3.1-flash-lite-preview",
                "gemini-3-flash-preview",
                "gemini-2.5-pro",
                "gemini-2.5-flash-lite",
            ],
            Self::Nous => &[
                "moonshotai/kimi-k2.6",
                "xiaomi/mimo-v2.5-pro",
                "xiaomi/mimo-v2.5",
            ],
            Self::OpenAiCompatible | Self::AnthropicCompatible => &[],
        }
    }
}

// Key URLs are adapted from classic NemoClaw main at
// 32c42bbad69dca3bb3f4e11ea439c8ce4898d4ff: the `helpUrl` of each
// `REMOTE_PROVIDER_CONFIG` entry in src/lib/onboard/providers.ts,
// OPENROUTER_HELP_URL in src/lib/inference/openrouter.ts, and
// HERMES_NOUS_API_KEY_HELP_URL in src/lib/onboard/hermes-auth.ts. Only the
// URLs are taken; the compatible-endpoint presets have none upstream either.
fn provider_profile(inference: ProviderPreset) -> ProviderProfile {
    match inference {
        ProviderPreset::NvidiaEndpoints => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            endpoint: "https://integrate.api.nvidia.com/v1",
            credential: "NVIDIA_API_KEY",
            custom_endpoint: false,
            default_model: Some(NVIDIA_MODEL),
            key_url: Some("https://build.nvidia.com/settings/api-keys"),
        },
        ProviderPreset::OpenRouter => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            endpoint: "https://openrouter.ai/api/v1",
            credential: "OPENROUTER_API_KEY",
            custom_endpoint: false,
            default_model: Some(NVIDIA_MODEL),
            key_url: Some("https://openrouter.ai/workspaces/default/keys"),
        },
        ProviderPreset::OpenAi => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            endpoint: "https://api.openai.com/v1",
            credential: "OPENAI_API_KEY",
            custom_endpoint: false,
            default_model: Some("gpt-5.4"),
            key_url: Some("https://platform.openai.com/api-keys"),
        },
        ProviderPreset::OpenAiCompatible => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            endpoint: "https://inference.example.com/v1",
            credential: "COMPATIBLE_API_KEY",
            custom_endpoint: true,
            default_model: None,
            key_url: None,
        },
        ProviderPreset::Anthropic => ProviderProfile {
            kind: InferenceProviderKind::Anthropic,
            endpoint: "https://api.anthropic.com",
            credential: "ANTHROPIC_API_KEY",
            custom_endpoint: false,
            default_model: Some("claude-sonnet-4-6"),
            key_url: Some("https://console.anthropic.com/settings/keys"),
        },
        ProviderPreset::AnthropicCompatible => ProviderProfile {
            kind: InferenceProviderKind::Anthropic,
            endpoint: "https://anthropic.example.com",
            credential: "COMPATIBLE_ANTHROPIC_API_KEY",
            custom_endpoint: true,
            default_model: None,
            key_url: None,
        },
        ProviderPreset::Gemini => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
            credential: "GEMINI_API_KEY",
            custom_endpoint: false,
            default_model: Some("gemini-3.6-flash"),
            key_url: Some("https://aistudio.google.com/app/apikey"),
        },
        ProviderPreset::Nous => ProviderProfile {
            kind: InferenceProviderKind::Openai,
            endpoint: "https://inference-api.nousresearch.com/v1",
            credential: "NOUS_API_KEY",
            custom_endpoint: false,
            default_model: Some("moonshotai/kimi-k2.6"),
            key_url: Some("https://portal.nousresearch.com/manage-subscription"),
        },
    }
}
