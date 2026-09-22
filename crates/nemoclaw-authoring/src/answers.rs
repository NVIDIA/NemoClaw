// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::capabilities::NVIDIA_MODEL;
use nemoclaw_sdk::config::{ComputeDriver, HarnessKind, InferenceApi};

pub type HarnessChoice = HarnessKind;
pub type RuntimeChoice = ComputeDriver;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InferenceChoice {
    NvidiaHosted,
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
    pub inference: InferenceChoice,
    pub api: ApiChoice,
    pub provider_name: String,
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
    pub inference: Option<InferenceChoice>,
    pub api: Option<ApiChoice>,
    pub provider_name: Option<String>,
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
            inference: InferenceChoice::NvidiaHosted,
            api: ApiChoice::OpenaiCompletions,
            provider_name: "hosted-nvidia-prod".into(),
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
        self.model = inputs.model.unwrap_or(self.model);
        self.credential_env = inputs.credential_env.unwrap_or(self.credential_env);
        self
    }
}
