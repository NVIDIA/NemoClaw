// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded load-only startup and resident-model checks.

use crate::{
    Error,
    services::installers::ollama::{ManagedOllama, Models},
};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

async fn response(mut response: reqwest::Response) -> Result<Vec<u8>, Error> {
    if response.status() != reqwest::StatusCode::OK {
        return Err(Error::State("Ollama observation was rejected"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::State("Ollama observation is incomplete"))?
    {
        if bytes.len() + chunk.len() > 1 << 20 {
            return Err(Error::State("Ollama observation exceeds limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) async fn load(
    client: &reqwest::Client,
    endpoint: &str,
    service: &ManagedOllama,
) -> Result<(), Error> {
    let models = Models::new(&format!("{endpoint}/v1"))?;
    models.ready(&service.model.name).await?;
    let installed = models
        .read(&service.model.name)
        .await?
        .ok_or(Error::State("pinned Ollama model is absent"))?;
    if installed.digest != service.model.digest {
        return Err(Error::Conflict("installed Ollama model digest changed"));
    }
    let result = client
        .post(format!("{endpoint}/api/generate"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(
            serde_json::to_vec(&json!({
                "model": service.model.name,
                "stream": false,
                "keep_alive": -1,
                "options": {"num_ctx": service.serving.context_tokens}
            }))
            .expect("load request"),
        )
        .send()
        .await
        .map_err(|_| Error::State("Ollama model load failed"))?;
    #[derive(Deserialize)]
    struct Loaded {
        done: bool,
        done_reason: String,
        response: String,
        #[serde(default)]
        eval_count: u64,
    }
    let loaded: Loaded = serde_json::from_slice(&response(result).await?)
        .map_err(|_| Error::State("Ollama load observation is incomplete"))?;
    if !loaded.done
        || loaded.done_reason != "load"
        || !loaded.response.is_empty()
        || loaded.eval_count != 0
    {
        return Err(Error::State("Ollama did not confirm a load-only request"));
    }
    Ok(())
}

pub(crate) async fn check(
    client: &reqwest::Client,
    endpoint: &str,
    service: &ManagedOllama,
    budget: u64,
) -> Result<(), Error> {
    let work = async {
        let result = client
            .get(format!("{endpoint}/api/ps"))
            .send()
            .await
            .map_err(|_| Error::State("Ollama loaded-model observation failed"))?;
        validate_loaded(service, budget, &response(result).await?)
    };
    tokio::time::timeout(Duration::from_secs(10), work)
        .await
        .map_err(|_| Error::State("Ollama loaded-model observation timed out"))?
}

fn validate_loaded(service: &ManagedOllama, budget: u64, bytes: &[u8]) -> Result<(), Error> {
    #[derive(Deserialize)]
    struct Inventory {
        models: Vec<Loaded>,
    }
    #[derive(Deserialize)]
    struct Loaded {
        name: String,
        digest: String,
        size: u64,
        size_vram: u64,
        context_length: u64,
    }
    let inventory: Inventory = serde_json::from_slice(bytes)
        .map_err(|_| Error::State("Ollama loaded-model observation is incomplete"))?;
    if inventory.models.len() != 1 {
        return Err(Error::Conflict(
            "Ollama must retain exactly one selected model",
        ));
    }
    let model = &inventory.models[0];
    if model.name != service.model.name
        || model.digest != service.model.digest
        || model.size == 0
        || model.size_vram != model.size
        || model.size_vram > budget
        || model.context_length != service.serving.context_tokens as u64
    {
        return Err(Error::Conflict(
            "Ollama loaded model violates its identity, GPU memory, context, or no-CPU-offload contract",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> ManagedOllama {
        let mut service = ManagedOllama::default();
        service.model.name = "qwen3:0.6b".into();
        service.model.digest = "a".repeat(64);
        service.serving.context_tokens = 8192;
        service
    }

    #[test]
    fn resident_check_rejects_cpu_fallback_and_drift() {
        let service = service();
        let model = json!({"name":service.model.name,"digest":service.model.digest,"size":1024,"size_vram":1024,"context_length":8192});
        validate_loaded(
            &service,
            2048,
            &serde_json::to_vec(&json!({"models":[model.clone()]})).unwrap(),
        )
        .unwrap();
        for (key, value) in [
            ("size_vram", json!(512)),
            ("size", json!(0)),
            ("context_length", json!(4096)),
            ("digest", json!("b".repeat(64))),
        ] {
            let mut changed = model.clone();
            changed[key] = value;
            assert!(
                validate_loaded(
                    &service,
                    2048,
                    &serde_json::to_vec(&json!({"models":[changed]})).unwrap(),
                )
                .is_err()
            );
        }
    }
}
