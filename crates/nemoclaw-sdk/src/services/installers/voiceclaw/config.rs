// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::config::{ConfigError, Credential, ImagePullPolicy};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[schemars(rename = "VoiceclawService")]
#[serde(default, deny_unknown_fields)]
/// Managed VoiceClaw runtime backed by one immutable local Docker image.
pub struct Service {
    /// Immutable local Docker image ID. VoiceClaw does not pull or build images.
    pub image: String,
    /// Must be Never for the preloaded PoC image.
    #[serde(
        rename = "imagePullPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(default, with = "ImagePullPolicy")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    /// Speech provider and protected caller credential reference.
    pub speech: Speech,
    /// VoiceClaw listener and bounded startup settings.
    #[schemars(default)]
    pub serving: Serving,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[schemars(rename = "VoiceclawSpeech")]
#[serde(default, deny_unknown_fields)]
/// Speech adapter selected for VoiceClaw.
pub struct Speech {
    /// Supported speech provider.
    pub provider: SpeechProvider,
    /// Host credential reference projected through protected runtime storage.
    pub credential: Credential,
}

#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
#[serde(rename_all = "lowercase")]
/// Speech provider supported by the initial VoiceClaw package.
pub enum SpeechProvider {
    #[default]
    Nvidia,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[schemars(!default)]
#[schemars(rename = "VoiceclawServing")]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
/// VoiceClaw listener and readiness deadline.
pub struct Serving {
    /// Single HTTP and streaming service port.
    pub port: i64,
    /// Seconds allowed for authenticated readiness.
    pub startup_timeout_seconds: i64,
}

impl Service {
    pub(crate) fn defaults(&mut self) {
        if self.serving.port == 0 {
            self.serving.port = 18790;
        }
        if self.serving.startup_timeout_seconds == 0 {
            self.serving.startup_timeout_seconds = 180;
        }
    }

    pub(crate) fn validate(&self) -> Result<(), ConfigError> {
        let local = regex::Regex::new(crate::config::constraints::LOCAL_IMAGE_ID)
            .expect("constant local image expression")
            .is_match(&self.image);
        super::super::super::contract::validate_image(&self.image, self.image_pull_policy, true)?;
        crate::config::validation::require(
            local && self.image_pull_policy == Some(ImagePullPolicy::Never),
            "VoiceClaw requires a preloaded local Docker image ID and imagePullPolicy Never",
        )?;
        crate::config::validation::credential(&Some(self.speech.credential.clone()))?;
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
