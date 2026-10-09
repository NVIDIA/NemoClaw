// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::installers;
use crate::{
    ObservationError,
    backend::{Backend, Row},
};
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
        if crate::cluster_services::ClusterServicesBackend::supports(kind) {
            return Ok(Some(Box::new(
                crate::cluster_services::ClusterServicesBackend::new(),
            )));
        }
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
        if crate::kubernetes::KubernetesBackend::supports(kind) {
            return Ok(Some(Box::new(crate::kubernetes::KubernetesBackend::new())));
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
