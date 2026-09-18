// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod authentication;
mod hardware;
mod inline_recipe;
mod process;
mod recipe;
mod runtime;

use nemoclaw_sdk::{CancellationToken, Error, services::installers::vllm::Service};

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
    let spec: Service = serde_json::from_str(&text)
        .map_err(|_| Error::State("invalid pinned runtime specification"))?;
    spec.validate()?;
    runtime::run(&spec, cancel, trip).await
}
