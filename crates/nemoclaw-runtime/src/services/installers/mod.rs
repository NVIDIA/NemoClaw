// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod ollama;
mod vllm;

use nemoclaw_sdk::{CancellationToken, Error};

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
    let definition: nemoclaw_sdk::services::ServiceDefinition = serde_json::from_str(&text)
        .map_err(|_| Error::State("invalid pinned runtime specification"))?;
    match definition {
        nemoclaw_sdk::services::ServiceDefinition::Ollama(service) => {
            service.validate()?;
            ollama::run(&service, cancel, trip).await
        }
        nemoclaw_sdk::services::ServiceDefinition::Vllm(service) => {
            service.validate()?;
            vllm::run(&service, cancel, trip).await
        }
        nemoclaw_sdk::services::ServiceDefinition::OllamaProxy(_) => Err(Error::State(
            "proxy service cannot use the managed runtime entry point",
        )),
    }
}
