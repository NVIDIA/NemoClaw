// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Answers, ApiChoice, HarnessChoice, InferenceChoice, RuntimeChoice};

pub(crate) const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";

/// An offered combination and its allowed models; policy details stay internal.
#[derive(Clone, Debug)]
pub struct Scenario {
    pub(crate) harness: HarnessChoice,
    pub(crate) runtime: RuntimeChoice,
    pub(crate) inference: InferenceChoice,
    pub(crate) api: ApiChoice,
    pub(crate) harness_kind: &'static str,
    pub(crate) provider_kind: &'static str,
    pub(crate) provider_api: &'static str,
    pub(crate) endpoint: &'static str,
    pub(crate) network_binary: &'static str,
    pub(crate) filesystem_read_only: &'static str,
    pub(crate) models: &'static [&'static str],
}

/// Curated authoring choices, not runtime discovery or the full SDK schema.
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
    pub fn inference(&self) -> InferenceChoice {
        self.inference
    }
    pub fn api(&self) -> ApiChoice {
        self.api
    }
    pub fn models(&self) -> &[&str] {
        self.models
    }
}

impl Capabilities {
    /// Lists authoring presets, not all configurations accepted by the SDK.
    pub fn scenarios(&self) -> &[Scenario] {
        &self.scenarios
    }

    pub fn available() -> Self {
        Self {
            scenarios: vec![
                Scenario {
                    harness: HarnessChoice::OpenClaw,
                    runtime: RuntimeChoice::Docker,
                    inference: InferenceChoice::NvidiaHosted,
                    api: ApiChoice::OpenAiCompletions,
                    harness_kind: "openclaw",
                    provider_kind: "openai",
                    provider_api: "openai-completions",
                    endpoint: "https://integrate.api.nvidia.com/v1",
                    network_binary: "/usr/bin/openclaw",
                    filesystem_read_only: "/app",
                    models: &[NVIDIA_MODEL],
                },
                Scenario {
                    harness: HarnessChoice::OpenClaw,
                    runtime: RuntimeChoice::Docker,
                    inference: InferenceChoice::NvidiaHosted,
                    api: ApiChoice::OpenAiResponses,
                    harness_kind: "openclaw",
                    provider_kind: "openai",
                    provider_api: "openai-responses",
                    endpoint: "https://integrate.api.nvidia.com/v1",
                    network_binary: "/usr/bin/openclaw",
                    filesystem_read_only: "/app",
                    models: &[NVIDIA_MODEL],
                },
                Scenario {
                    harness: HarnessChoice::Hermes,
                    runtime: RuntimeChoice::Docker,
                    inference: InferenceChoice::NvidiaHosted,
                    api: ApiChoice::OpenAiCompletions,
                    harness_kind: "hermes",
                    provider_kind: "openai",
                    provider_api: "openai-completions",
                    endpoint: "https://integrate.api.nvidia.com/v1",
                    network_binary: "/opt/fabric/bin/python",
                    filesystem_read_only: "/opt/hermes",
                    models: &[NVIDIA_MODEL],
                },
            ],
        }
    }

    pub(crate) fn scenario(
        &self,
        harness: HarnessChoice,
        runtime: RuntimeChoice,
        inference: InferenceChoice,
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
