// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    Error,
    hardware::Capacity,
    services::installers::ollama::{ManagedOllama, hardware_capacity},
};
use process_wrap::tokio::CommandWrap;
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};

pub(crate) struct Readiness {
    endpoint: String,
    service: ManagedOllama,
    budget: u64,
}

pub(crate) fn launch(
    service: &ManagedOllama,
    model: &Path,
    capacity: &Capacity,
) -> Result<(CommandWrap, Readiness), Error> {
    let directory = model
        .to_str()
        .ok_or(Error::State("invalid Ollama model storage path"))?;
    let total = hardware_capacity::serving_memory(service, capacity)?;
    let budget = hardware_capacity::budget(service, capacity)?;
    let overhead = capacity.gpu_memory.as_ref().map_or(Ok(0), |gpu| {
        gpu.free.checked_sub(budget).ok_or(Error::Conflict(
            "available GPU memory does not satisfy the Ollama budget",
        ))
    })?;
    if budget > total {
        return Err(Error::Conflict("invalid Ollama serving budget"));
    }
    let environment: BTreeMap<String, String> = [
        ("OLLAMA_HOST", format!("0.0.0.0:{}", service.serving.port)),
        ("OLLAMA_MODELS", directory.into()),
        (
            "OLLAMA_CONTEXT_LENGTH",
            service.serving.context_tokens.to_string(),
        ),
        (
            "OLLAMA_NUM_PARALLEL",
            service.serving.max_sequences.to_string(),
        ),
        ("OLLAMA_MAX_LOADED_MODELS", "1".into()),
        ("OLLAMA_KEEP_ALIVE", "-1".into()),
        ("OLLAMA_GPU_OVERHEAD", overhead.to_string()),
        (
            "OLLAMA_LOAD_TIMEOUT",
            format!("{}s", service.serving.startup_timeout_seconds),
        ),
        ("OLLAMA_NOPRUNE", "true".into()),
        ("OLLAMA_NO_CLOUD", "true".into()),
        ("OLLAMA_VULKAN", "false".into()),
    ]
    .into_iter()
    .map(|(key, value)| (key.into(), value))
    .collect();
    let command = CommandWrap::with_new("/bin/ollama", |command| {
        command
            .arg("serve")
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
    });
    Ok((
        command,
        Readiness {
            endpoint: format!("http://127.0.0.1:{}", service.serving.port),
            service: service.clone(),
            budget,
        },
    ))
}

pub(crate) async fn wait_ready(
    readiness: Readiness,
    ready: tokio::sync::mpsc::Sender<bool>,
) -> Result<(), Error> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(
            readiness.service.serving.startup_timeout_seconds as u64,
        ))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| Error::State("cannot initialize Ollama readiness transport"))?;
    super::observation::load(&client, &readiness.endpoint, &readiness.service).await?;
    super::observation::check(
        &client,
        &readiness.endpoint,
        &readiness.service,
        readiness.budget,
    )
    .await?;
    let _ = ready.send(true).await;
    Ok(())
}
