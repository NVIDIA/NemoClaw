// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;

use crate::{Error, ObservationError};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, time::Duration};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Model {
    pub name: String,
    pub digest: String,
    pub size: u64,
}
pub struct Models {
    endpoint: String,
    http: reqwest::Client,
}
impl Models {
    /// The caller must verify the owned Docker parent before using its
    /// unauthenticated model API. Redirects and environment proxies are disabled.
    pub fn new(endpoint: &str) -> Result<Self, Error> {
        let url =
            url::Url::parse(endpoint).map_err(|_| Error::Conflict("invalid Ollama endpoint"))?;
        if url.scheme() != "http"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/v1"
            || !matches!(url.host(), Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)))
        {
            return Err(Error::Conflict(
                "Ollama requires an explicit IP endpoint ending in /v1",
            ));
        }
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(30))
            .read_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| Error::State("cannot configure Ollama transport"))?;
        Ok(Self {
            endpoint: endpoint.trim_end_matches("/v1").into(),
            http,
        })
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<reqwest::Response, Error> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.endpoint))
            .header(reqwest::header::CONTENT_TYPE, "application/json");
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.map_err(|error| transport(&error))?;
        match response.status() {
            reqwest::StatusCode::OK => Ok(response),
            reqwest::StatusCode::UNAUTHORIZED => Err(ObservationError::Authentication.into()),
            reqwest::StatusCode::FORBIDDEN => Err(ObservationError::Permission.into()),
            _ => Err(Error::Observation(ObservationError::Query)),
        }
    }
    /// Active startup probe after a verified parent start. Only connection refusal
    /// is retried, for at most 30 seconds; inventory and authentication failures
    /// stop immediately. No model mutations occur here.
    pub async fn ready(&self, name: &str) -> Result<(), Error> {
        let ready = async {
            loop {
                match self.read(name).await {
                    Ok(_) => return Ok(()),
                    Err(Error::ServiceStarting) => {
                        tokio::time::sleep(Duration::from_millis(200)).await
                    }
                    Err(error) => return Err(error),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(30), ready).await
            .map_err(|_| Error::Conflict("Ollama inventory did not become available; model installation was not attempted"))?
    }
    pub async fn read(&self, name: &str) -> Result<Option<Model>, Error> {
        let work = async {
            let mut response = self
                .request(reqwest::Method::GET, "/api/tags", None)
                .await?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| transport(&error))? {
                if bytes.len() + chunk.len() > 1 << 20 {
                    return Err(ObservationError::Incomplete.into());
                }
                bytes.extend(chunk);
            }
            #[derive(Deserialize)]
            struct Inventory {
                models: Vec<Model>,
            }
            let result: Inventory =
                serde_json::from_slice(&bytes).map_err(|_| ObservationError::Incomplete)?;
            let mut seen = BTreeSet::new();
            let mut found = None;
            for model in result.models {
                if model.name.is_empty()
                    || model.digest.len() != 64
                    || !model.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || model.size == 0
                    || !seen.insert(model.name.clone())
                {
                    return Err(ObservationError::Incomplete.into());
                }
                if model.name == name {
                    found = Some(model);
                }
            }
            Ok(found)
        };
        tokio::time::timeout(Duration::from_secs(20), work)
            .await
            .map_err(|_| ObservationError::Transport)?
    }
    /// Pull only after a complete inventory confirms absence. Never retry a
    /// mutation in this call; an interrupted stream requires explicit reapply.
    pub async fn ensure(&self, name: &str) -> Result<Model, Error> {
        if let Some(model) = self.read(name).await? {
            return Ok(model);
        }
        #[derive(Serialize)]
        struct Pull<'a> {
            model: &'a str,
            stream: bool,
        }
        let body = serde_json::to_vec(&Pull {
            model: name,
            stream: true,
        })
        .expect("pull request");
        let mut progress = crate::download::Reporter::new(name);
        let mut response = self
            .request(reqwest::Method::POST, "/api/pull", Some(body))
            .await?;
        let mut line = Vec::new();
        let mut complete = false;
        while let Some(chunk) = response.chunk().await.map_err(|error| transport(&error))? {
            for byte in chunk {
                if byte == b'\n' {
                    event(&line, &mut complete, &mut progress)?;
                    line.clear();
                } else {
                    if line.len() >= 1 << 20 {
                        return Err(Error::State(
                            "Ollama pull event exceeds limit; retained artifacts require reconciliation",
                        ));
                    }
                    line.push(byte);
                }
            }
        }
        if !line.is_empty() {
            event(&line, &mut complete, &mut progress)?;
        }
        if !complete {
            return Err(Error::Conflict(
                "Ollama pull interrupted; retain storage and reapply the same configuration",
            ));
        }
        let model = self.read(name).await?.ok_or(Error::Conflict(
            "Ollama pull claimed success without a confirmed model",
        ))?;
        progress.complete();
        Ok(model)
    }
}
fn event(
    line: &[u8],
    complete: &mut bool,
    progress: &mut crate::download::Reporter,
) -> Result<(), Error> {
    use crate::{ByteProgress, DownloadPhase};
    #[derive(Deserialize)]
    struct Event {
        #[serde(default)]
        status: String,
        #[serde(default)]
        error: String,
        // Optional progress fields do not change whether the pull succeeds.
        #[serde(default)]
        digest: serde_json::Value,
        #[serde(default)]
        completed: serde_json::Value,
        #[serde(default)]
        total: serde_json::Value,
    }
    let event: Event = serde_json::from_slice(line)
        .map_err(|_| Error::State("Ollama pull response is incomplete"))?;
    if *complete || event.status.is_empty() || !event.error.is_empty() {
        return Err(Error::Conflict(
            "Ollama pull response is invalid or failed; retained artifacts require reconciliation",
        ));
    }
    *complete = event.status == "success";
    if event.status.starts_with("pulling ") {
        if let Some(layer) = crate::download::layer_id(event.digest.as_str()) {
            progress.report(
                Some(layer),
                DownloadPhase::Downloading,
                event.completed.as_u64().map(|completed| ByteProgress {
                    completed,
                    total: event.total.as_u64().filter(|total| *total > 0),
                }),
            );
        }
    } else if event.status == "verifying sha256 digest" {
        progress.report(None, DownloadPhase::Verifying, None);
    }
    Ok(())
}
fn transport(error: &reqwest::Error) -> Error {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(cause) = source {
        if cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            return Error::ServiceStarting;
        }
        source = cause.source();
    }
    ObservationError::Transport.into()
}
