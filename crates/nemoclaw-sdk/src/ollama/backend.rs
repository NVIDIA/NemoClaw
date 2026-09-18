// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Models, ServiceSpec};
use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
    docker::Engine,
};

/// Shared provider and export observations for an explicitly configured engine.
pub struct OllamaBackend {
    pub(super) engine: Engine,
}
impl OllamaBackend {
    pub fn new(engine: Engine) -> Self {
        Self { engine }
    }
    pub fn supports(kind: &str) -> bool {
        matches!(kind, "ollama" | "ollama_model" | "ollama_storage") || super::proxy::supports(kind)
    }
    async fn observe(
        &self,
        kind: &str,
        row: &Row,
        apply: bool,
        removing: bool,
    ) -> Result<Option<Row>, Error> {
        if super::proxy::supports(kind) {
            return self.proxy_read(kind, row, apply, removing).await;
        }
        let field = |name: &str| {
            row.get(name)
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or(ObservationError::Incomplete)
        };
        let mut result = row.clone();
        if matches!(kind, "ollama" | "ollama_storage") {
            let spec = ServiceSpec {
                proxy: None,
                name: field("name")?,
                owner: field("owner")?,
                generation: field("generation")?,
                image: field("image")?,
                network: field("network")?,
                bind_address: field("bind_address")?,
            };
            let id = row.get("id").map(String::as_str).unwrap_or("");
            if kind == "ollama_storage" {
                let storage = if apply {
                    Some(self.engine.ensure_ollama_storage(&spec, id).await?)
                } else {
                    self.engine.observe_ollama_storage(&spec, id).await?
                };
                return Ok(storage.map(|id| {
                    result.insert("id".into(), id);
                    result
                }));
            }
            let service = if removing {
                self.engine.observe_ollama_removal(&spec, id).await?
            } else if apply {
                if field("running")? != "true" {
                    return Err(Error::Conflict("managed Ollama requires running = true"));
                }
                Some(self.engine.ensure_ollama(&spec, id).await?)
            } else {
                self.engine.observe_ollama(&spec, id).await?
            };
            return Ok(service.map(|service| {
                result.insert("id".into(), service.id);
                result.insert("running".into(), service.running.to_string());
                result
            }));
        }
        if kind != "ollama_model" {
            return Err(ObservationError::Incomplete.into());
        }
        let service_id = field("service_id")?;
        let endpoint = field("endpoint")?;
        let name = field("model")?;
        let service = self.engine.bound_ollama(&service_id, &endpoint).await?;
        if removing {
            // Destroy releases the model installation binding, never model bytes.
            // Verify the bound parent and storage without requiring its inference API.
            return Ok(Some(result));
        }
        if !service.running {
            return Err(Error::Conflict(
                "Ollama service is stopped; model inventory is unknown; no model mutation is authorized",
            ));
        }
        let models = Models::new(&endpoint)?;
        let model = if apply {
            models.ready(&name).await?;
            Some(models.ensure(&name).await?)
        } else {
            models.read(&name).await?
        };
        Ok(model.map(|model| {
            result.insert("id".into(), format!("{service_id}/model"));
            result.insert("digest".into(), model.digest);
            result
        }))
    }
}
fn diagnostic(error: &Error) -> ObservationError {
    match error {
        Error::Observation(error) => *error,
        Error::State(message) | Error::Conflict(message) => ObservationError::Backend(message),
        Error::PartialRuntime => ObservationError::Backend(
            "Ollama process is absent but owned persistent storage remains",
        ),
        _ => ObservationError::Incomplete,
    }
}
#[async_trait::async_trait]
impl Backend for OllamaBackend {
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.observe(kind, prior, false, removing)
            .await
            .map_err(|error| diagnostic(&error))
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.observe(kind, desired, true, false).await {
            Ok(Some(row)) => Mutation::complete(row),
            Ok(None) => Mutation::failed(ObservationError::Incomplete),
            Err(error) => Mutation::failed(diagnostic(&error)),
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if destroying && super::proxy::supports(kind) {
            return self
                .proxy_remove(kind, prior)
                .await
                .map_err(|e| diagnostic(&e));
        }
        if !destroying || kind == "ollama_storage" {
            return Err(ObservationError::Backend(
                "Ollama storage is retained; service deletion requires explicit destroy",
            ));
        }
        if kind == "ollama_model" {
            self.observe(kind, prior, false, true)
                .await
                .map_err(|error| diagnostic(&error))?;
            return Ok(());
        }
        if kind != "ollama" {
            return Err(ObservationError::Incomplete);
        }
        let field = |key: &str| {
            prior
                .get(key)
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or(ObservationError::Incomplete)
        };
        let spec = ServiceSpec {
            proxy: None,
            name: field("name")?,
            owner: field("owner")?,
            generation: field("generation")?,
            image: field("image")?,
            network: field("network")?,
            bind_address: field("bind_address")?,
        };
        self.engine
            .remove_ollama(&spec, &field("id")?)
            .await
            .map_err(|error| diagnostic(&error))
    }
}
