// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Load-only startup and resident checks for the Ollama backend. No prompt or
//! generation request is issued by apply. The shared supervisor stops the owned
//! process group when these observations fail.
use nemoclaw_sdk::{Error, config::Service};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

async fn response(response: reqwest::Response) -> Result<Vec<u8>, Error> {
    if response.status() != reqwest::StatusCode::OK {
        return Err(Error::State("Ollama observation was rejected"));
    }
    let mut response = response;
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
    service: &Service,
) -> Result<(), Error> {
    let models = nemoclaw_sdk::ollama::Models::new(&format!("{endpoint}/v1"))?;
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
            serde_json::to_vec(
                &json!({"model":service.model.name,"stream":false,"keep_alive":-1,
            "options":{"num_ctx":service.serving.context_tokens}}),
            )
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
    service: &Service,
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
fn validate_loaded(service: &Service, budget: u64, bytes: &[u8]) -> Result<(), Error> {
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
    fn service() -> Service {
        let mut s = Service {
            backend: "ollama".into(),
            ..Default::default()
        };
        s.model.name = "qwen3:0.6b".into();
        s.model.digest = "a".repeat(64);
        s.serving.context_tokens = 8192;
        s
    }
    #[test]
    fn loaded_observation_rejects_cpu_fallback_overbudget_drift_and_unknown_capacity() {
        let s = service();
        let model = json!({"name":s.model.name,"digest":s.model.digest,"size":1024,"size_vram":1024,"context_length":8192});
        let check = |m| {
            validate_loaded(
                &s,
                2048,
                &serde_json::to_vec(&json!({"models":[m]})).unwrap(),
            )
        };
        check(model.clone()).unwrap();
        for (key, value) in [
            ("size_vram", json!(512)),
            ("size", json!(0)),
            ("size_vram", json!(4096)),
            ("context_length", json!(4096)),
            ("digest", json!("b".repeat(64))),
        ] {
            let mut changed = model.clone();
            changed[key] = value;
            assert!(check(changed).is_err(), "{key}");
        }
        let mut missing = model;
        missing.as_object_mut().unwrap().remove("context_length");
        assert!(check(missing).is_err());
        assert!(validate_loaded(&s, 2048, b"{\"models\":[]}").is_err());
    }

    #[tokio::test]
    async fn startup_checks_pinned_inventory_then_loads_without_prompt_or_generation() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let s = service();
        let expected = s.clone();
        let server = tokio::spawn(async move {
            for step in 0..4 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") {
                    header.push(stream.read_u8().await.unwrap());
                }
                let header = String::from_utf8(header).unwrap();
                let result=match step {
                    0 | 1 => {
                        assert!(header.starts_with("GET /api/tags "));
                        json!({"models":[{"name":expected.model.name,"digest":expected.model.digest,"size":1024}]})
                    },
                    2 => {
                        assert!(header.starts_with("POST /api/generate "));
                        let length:usize=header.lines().find_map(|l|l.strip_prefix("content-length: ")).unwrap().parse().unwrap();
                        let mut body=vec![0;length]; stream.read_exact(&mut body).await.unwrap();
                        let body:serde_json::Value=serde_json::from_slice(&body).unwrap();
                        assert_eq!(body,json!({"model":expected.model.name,"stream":false,"keep_alive":-1,"options":{"num_ctx":8192}}));
                        json!({"done":true,"done_reason":"load","response":""})
                    },
                    _ => {
                        assert!(header.starts_with("GET /api/ps "));
                        json!({"models":[{"name":expected.model.name,"digest":expected.model.digest,"size":1024,"size_vram":1024,"context_length":8192}]})
                    }
                }.to_string();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{result}",result.len()).as_bytes()).await.unwrap();
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        load(&client, &endpoint, &s).await.unwrap();
        check(&client, &endpoint, &s, 2048).await.unwrap();
        server.await.unwrap();
    }
}
