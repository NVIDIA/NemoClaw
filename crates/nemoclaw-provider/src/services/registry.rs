// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::installers;
use crate::{
    ObservationError,
    backend::{Backend, Row},
};
#[cfg(test)]
use nemoclaw_sdk::services::resource_schemas;
/// Resolves a provider resource row to its package-owned backend.
pub struct BackendRegistry<'a> {
    connections: &'a crate::docker::Connections,
}

impl<'a> BackendRegistry<'a> {
    pub fn new(connections: &'a crate::docker::Connections) -> Self {
        Self { connections }
    }

    pub fn resolve(
        &self,
        kind: &str,
        row: &Row,
    ) -> Result<Option<Box<dyn Backend>>, ObservationError> {
        if matches!(
            kind,
            installers::vllm::STORAGE_KIND | installers::ollama::STORAGE_KIND
        ) {
            let storage_kind = if kind == installers::vllm::STORAGE_KIND {
                installers::vllm::STORAGE_KIND
            } else {
                installers::ollama::STORAGE_KIND
            };
            let engine = crate::managed::runtime_engine(self.connections, kind, row)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(Box::new(crate::managed::ManagedBackend::storage(
                engine,
                storage_kind,
            ))));
        }
        if crate::managed::ManagedBackend::supports(kind) {
            let engine = crate::managed::runtime_engine(self.connections, kind, row)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(Box::new(crate::managed::ManagedBackend::new(engine))));
        }
        if installers::ollama::ProxyBackend::supports(kind) {
            let endpoint = row
                .get("engine")
                .filter(|endpoint| !endpoint.is_empty())
                .ok_or(ObservationError::Incomplete)?;
            let engine = self
                .connections
                .resolve(endpoint)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(Box::new(installers::ollama::ProxyBackend::new(
                engine,
            ))));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn docker_provider_compute_is_not_a_custom_provider_resource() {
        let schemas = resource_schemas();
        for kind in ["inference_service", "ollama_service", "ollama_proxy"] {
            assert!(!schemas.iter().any(|schema| schema.kind == kind));
        }
        for kind in [
            "inference_storage",
            "ollama_service_storage",
            "ollama_proxy_storage",
            "ollama_external_model",
        ] {
            assert!(schemas.iter().any(|schema| schema.kind == kind));
        }
    }
}
