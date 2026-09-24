// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Package-neutral runtime entry point. Package dispatch remains inside the
//! service component alongside each installer's implementation.

pub(super) mod supervisor;

use crate::{CancellationToken, Error};

pub(super) async fn run(cancel: &CancellationToken, trip: &CancellationToken) -> Result<(), Error> {
    let text = match std::env::var("NEMOCLAW_RUNTIME_SPEC") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => {
            return Err(Error::State("missing runtime specification"));
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(Error::State("runtime specification is not UTF-8"));
        }
    };
    let definition: super::ServiceDefinition = serde_json::from_str(&text)
        .map_err(|_| Error::State("invalid pinned runtime specification"))?;
    match definition {
        super::ServiceDefinition::Ollama(service) => {
            service.validate()?;
            super::installers::ollama::runtime::run(&service, cancel, trip).await
        }
        super::ServiceDefinition::Vllm(service) => {
            service.validate()?;
            super::installers::vllm::runtime::run(&service, cancel, trip).await
        }
        super::ServiceDefinition::OllamaProxy(_) => Err(Error::State(
            "proxy service cannot use the managed runtime entry point",
        )),
        super::ServiceDefinition::Voiceclaw(_) => Err(Error::State(
            "VoiceClaw does not use the managed runtime entry point",
        )),
    }
}
