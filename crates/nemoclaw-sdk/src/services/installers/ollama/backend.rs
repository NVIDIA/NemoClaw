// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error, ObservationError,
    backend::{Backend, Mutation, Row},
    docker::Engine,
};

/// External Ollama proxy resource operations for an explicitly configured engine.
pub struct ProxyBackend {
    pub(super) engine: Engine,
}
impl ProxyBackend {
    pub fn new(engine: Engine) -> Self {
        Self { engine }
    }
    pub fn supports(kind: &str) -> bool {
        super::proxy::supports(kind)
    }
}
fn diagnostic(error: &Error) -> ObservationError {
    match error {
        Error::Observation(error) => *error,
        Error::State(message) | Error::Conflict(message) => ObservationError::Backend(message),
        Error::PartialRuntime => {
            ObservationError::Backend("Ollama proxy is absent but owned persistent storage remains")
        }
        _ => ObservationError::Incomplete,
    }
}
#[async_trait::async_trait]
impl Backend for ProxyBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        if prior.is_none() {
            self.proxy_read(kind, desired, false, false).await?;
        }
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.proxy_read(kind, prior, false, removing)
            .await
            .map_err(|error| diagnostic(&error))
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.proxy_read(kind, desired, true, false).await {
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
        if !Self::supports(kind) {
            return Err(ObservationError::Query);
        }
        if !destroying {
            return Err(ObservationError::Backend(
                "proxy deletion requires explicit destroy",
            ));
        }
        self.proxy_remove(kind, prior)
            .await
            .map_err(|error| diagnostic(&error))
    }
}
