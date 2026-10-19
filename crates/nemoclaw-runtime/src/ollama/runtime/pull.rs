// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Ollama downloads and stores the pinned model itself; NemoClaw checks the
//! digest and parameters Ollama reports before anything loads.

use crate::{
    CancellationToken, Error,
    ollama::{ManagedOllama, Models},
};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

/// Sampling parameters a model may set. Anything else, such as `num_ctx` or
/// `num_gpu`, would override the serving budget NemoClaw enforces.
const PARAMETERS: [&str; 13] = [
    "num_keep",
    "seed",
    "num_predict",
    "top_k",
    "top_p",
    "min_p",
    "typical_p",
    "temperature",
    "repeat_last_n",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
    "stop",
];

/// Reports a runtime phase and detail, as the supervisor does.
pub(crate) type Report<'a> = &'a (dyn Fn(&str, &str, u32) -> Result<(), Error> + Sync);

/// Make sure the running Ollama holds the pinned model, pulling it if absent.
/// A model with another digest, before or after the pull, stops startup.
pub(crate) async fn ensure(
    client: &reqwest::Client,
    endpoint: &str,
    service: &ManagedOllama,
    cancel: &CancellationToken,
    report: Report<'_>,
) -> Result<(), Error> {
    let models = Models::new(&format!("{endpoint}/v1"))?;
    let name = &service.model.name;
    models.ready(name).await?;
    match models.read(name).await? {
        Some(model) if model.digest == service.model.digest => {}
        Some(_) => {
            return Err(Error::Conflict(
                "installed Ollama model digest differs from the pinned digest",
            ));
        }
        None => {
            report("downloading", "Ollama is pulling the pinned model", 0)?;
            tokio::select! {
                () = cancel.cancelled() => return Err(Error::Cancelled),
                result = tokio::time::timeout(Duration::from_secs(8 * 3600), pull(client, endpoint, name, report)) => {
                    result.map_err(|_| Error::State("Ollama model download exceeded budget; partial data retained"))??;
                }
            }
            let pulled = models
                .read(name)
                .await?
                .ok_or(Error::State("Ollama did not install the pinned model"))?;
            if pulled.digest != service.model.digest {
                return Err(Error::Conflict(
                    "Ollama pulled a model whose digest differs from the pinned digest; the tag changed upstream",
                ));
            }
        }
    }
    parameters(client, endpoint, name).await
}

/// Ask Ollama to pull `name`, relaying its progress until it reports success.
async fn pull(
    client: &reqwest::Client,
    endpoint: &str,
    name: &str,
    report: Report<'_>,
) -> Result<(), Error> {
    let mut response = client
        .post(format!("{endpoint}/api/pull"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(json!({"model": name, "stream": true}).to_string())
        .send()
        .await
        .map_err(|_| Error::State("Ollama pull request failed"))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Error::State("Ollama rejected the pull request"));
    }
    #[derive(Deserialize)]
    struct Progress {
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: Option<String>,
    }
    let mut line = Vec::new();
    let mut last = String::new();
    let mut succeeded = false;
    let mut handle = |line: &[u8]| -> Result<(), Error> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let progress: Progress = serde_json::from_slice(line)
            .map_err(|_| Error::State("Ollama pull progress is unreadable"))?;
        if progress.error.is_some() {
            return Err(Error::State("Ollama could not pull the pinned model"));
        }
        succeeded = progress.status == "success";
        if progress.status != last {
            let status: String = progress.status.chars().take(160).collect();
            report("downloading", &status, 0)?;
            last = progress.status;
        }
        Ok(())
    };
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::State("Ollama pull progress ended early"))?
    {
        for byte in chunk {
            if byte == b'\n' {
                handle(&line)?;
                line.clear();
            } else if line.len() < 64 << 10 {
                line.push(byte);
            } else {
                return Err(Error::State("Ollama pull progress exceeds limit"));
            }
        }
    }
    handle(&line)?;
    if succeeded {
        Ok(())
    } else {
        Err(Error::State("Ollama pull ended without success"))
    }
}

/// Refuse a model whose parameters override anything but sampling.
async fn parameters(client: &reqwest::Client, endpoint: &str, name: &str) -> Result<(), Error> {
    let response = client
        .post(format!("{endpoint}/api/show"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(json!({"model": name}).to_string())
        .send()
        .await
        .map_err(|_| Error::State("Ollama model details are unobservable"))?;
    #[derive(Deserialize)]
    struct Show {
        #[serde(default)]
        parameters: String,
    }
    let show: Show = serde_json::from_slice(&super::observation::response(response).await?)
        .map_err(|_| Error::State("Ollama model details are incomplete"))?;
    let overrides = show
        .parameters
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .any(|key| !PARAMETERS.contains(&key));
    if overrides {
        return Err(Error::Conflict(
            "Ollama model parameters contain unsupported runner or resource overrides",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_fixture::Fixture;
    use std::sync::{Arc, Mutex};

    const PINNED: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn service() -> ManagedOllama {
        let mut service = ManagedOllama::default();
        service.model.name = "qwen3:0.6b".into();
        service.model.digest = PINNED.into();
        service
    }

    fn inventory(digest: Option<&str>) -> String {
        match digest {
            Some(digest) => format!(
                "{{\"models\":[{{\"name\":\"qwen3:0.6b\",\"digest\":\"{digest}\",\"size\":523}}]}}"
            ),
            None => "{\"models\":[]}".into(),
        }
    }

    /// Answers each request from `responses` in order and records its method and path.
    async fn run(responses: Vec<(u16, String)>) -> (Result<(), Error>, Vec<String>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let mut responses = responses.into_iter();
        let fixture = Fixture::start_tcp(move |request| {
            seen.lock()
                .unwrap()
                .push(format!("{} {}", request.method, request.path));
            responses
                .next()
                .map(|(status, body)| (status, body.into_bytes()))
        })
        .await;
        let result = ensure(
            &reqwest::Client::new(),
            &fixture.endpoint,
            &service(),
            &CancellationToken::new(),
            &|_, _, _| Ok(()),
        )
        .await;
        let requests = requests.lock().unwrap().clone();
        (result, requests)
    }

    const SHOW_ALLOWED: &str = "{\"parameters\":\"temperature 0.6\\nstop \\\"<|im_end|>\\\"\"}";

    #[tokio::test]
    async fn an_installed_pinned_model_is_not_pulled_again() {
        let (result, requests) = run(vec![
            (200, inventory(Some(PINNED))),
            (200, inventory(Some(PINNED))),
            (200, SHOW_ALLOWED.into()),
        ])
        .await;
        result.unwrap();
        assert!(
            !requests
                .iter()
                .any(|request| request.ends_with("/api/pull"))
        );
        assert!(requests.iter().any(|request| request == "POST /api/show"));
    }

    #[tokio::test]
    async fn an_absent_model_is_pulled_by_ollama_and_its_digest_checked() {
        let (result, requests) = run(vec![
            (200, inventory(None)),
            (200, inventory(None)),
            (
                200,
                "{\"status\":\"pulling manifest\"}\n{\"status\":\"success\"}\n".into(),
            ),
            (200, inventory(Some(PINNED))),
            (200, SHOW_ALLOWED.into()),
        ])
        .await;
        result.unwrap();
        assert!(requests.iter().any(|request| request == "POST /api/pull"));
    }

    #[tokio::test]
    async fn a_pulled_model_with_another_digest_is_refused() {
        let (result, _) = run(vec![
            (200, inventory(None)),
            (200, inventory(None)),
            (200, "{\"status\":\"success\"}\n".into()),
            (200, inventory(Some(OTHER))),
        ])
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("digest"), "{error}");
    }

    #[tokio::test]
    async fn an_installed_model_with_another_digest_is_refused_without_pulling() {
        let (result, requests) = run(vec![
            (200, inventory(Some(OTHER))),
            (200, inventory(Some(OTHER))),
        ])
        .await;
        assert!(result.unwrap_err().to_string().contains("digest"));
        assert!(
            !requests
                .iter()
                .any(|request| request.ends_with("/api/pull"))
        );
    }

    #[tokio::test]
    async fn a_pull_error_from_ollama_stops_startup() {
        let (result, _) = run(vec![
            (200, inventory(None)),
            (200, inventory(None)),
            (200, "{\"status\":\"pulling manifest\"}\n{\"error\":\"pull model manifest: file does not exist\"}\n".into()),
        ])
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn runner_or_resource_parameters_are_refused() {
        let (result, _) = run(vec![
            (200, inventory(Some(PINNED))),
            (200, inventory(Some(PINNED))),
            (
                200,
                "{\"parameters\":\"num_ctx 131072\\ntemperature 0.6\"}".into(),
            ),
        ])
        .await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("parameters"), "{error}");
    }
}
