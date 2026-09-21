// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::config::{ConfigError, Credential, ImagePullPolicy};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "VoiceclawService")]
#[serde(deny_unknown_fields)]
/// Managed VoiceClaw runtime backed by one immutable local Docker image.
pub struct Service {
    /// Immutable local Docker image ID. VoiceClaw does not pull or build images.
    #[schemars(regex(pattern = r"^sha256:[a-f0-9]{64}$"))]
    pub image: String,
    /// Must be Never for the preloaded PoC image.
    #[serde(rename = "imagePullPolicy")]
    pub image_pull_policy: PullPolicy,
    /// Speech provider and protected caller credential reference.
    pub speech: Speech,
    /// VoiceClaw listener and bounded startup settings.
    #[serde(default)]
    #[schemars(default)]
    pub serving: Serving,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "VoiceclawSpeech")]
#[serde(deny_unknown_fields)]
/// Speech adapter selected for VoiceClaw.
pub struct Speech {
    /// Supported speech provider.
    pub provider: SpeechProvider,
    /// Host credential reference projected through protected runtime storage.
    pub credential: Credential,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
/// Speech provider supported by the initial VoiceClaw package.
pub enum SpeechProvider {
    Nvidia,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// Image acquisition policy supported by VoiceClaw.
pub enum PullPolicy {
    Never,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(rename = "VoiceclawServing")]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// VoiceClaw listener and readiness deadline.
pub struct Serving {
    /// Single HTTP and streaming service port.
    #[serde(default = "default_port")]
    #[schemars(range(min = 1024, max = 65535))]
    pub port: i64,
    /// Seconds allowed for authenticated readiness.
    #[serde(default = "default_startup_timeout")]
    #[schemars(range(min = 1, max = 3600))]
    pub startup_timeout_seconds: i64,
}

fn default_port() -> i64 {
    18790
}

fn default_startup_timeout() -> i64 {
    180
}

impl Default for Serving {
    fn default() -> Self {
        Self {
            port: default_port(),
            startup_timeout_seconds: default_startup_timeout(),
        }
    }
}

impl Service {
    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        let local = regex::Regex::new(crate::config::constraints::LOCAL_IMAGE_ID)
            .expect("constant local image expression")
            .is_match(&self.image);
        super::super::super::contract::validate_image(
            &self.image,
            Some(ImagePullPolicy::Never),
            true,
        )?;
        crate::config::validation::require(
            local,
            "VoiceClaw requires a preloaded local Docker image ID and imagePullPolicy Never",
        )?;
        crate::config::validation::require(
            regex::Regex::new(crate::config::constraints::ENV)
                .expect("constant environment reference expression")
                .is_match(&self.speech.credential.env),
            "credential references require an uppercase environment variable name",
        )?;
        crate::config::validation::require(
            (1024..=65535).contains(&self.serving.port)
                && (1..=3600).contains(&self.serving.startup_timeout_seconds),
            "VoiceClaw requires one unprivileged port and a startup timeout from 1 through 3600 seconds",
        )
    }

    pub(crate) fn architecture() -> Result<&'static str, ConfigError> {
        match std::env::consts::ARCH {
            "aarch64" => Ok("arm64"),
            "x86_64" => Ok("amd64"),
            _ => Err(ConfigError::new(
                "VoiceClaw requires a supported native Linux architecture",
            )),
        }
    }
}
