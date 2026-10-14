// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed credential reads, shared with the OpenShell provider.
use crate::ObservationError;
use nemoclaw_sdk::services::authentication::Source;

pub use nemoclaw_docker::credentials::{read_key, read_proxy_key, read_service_key};

pub async fn resolve(source: &Source) -> Result<String, ObservationError> {
    let source = match source {
        Source::ClusterService { storage, .. } => {
            return crate::cluster_services::resolve_credential(storage).await;
        }
        Source::OllamaProxy {
            storage,
            container,
            endpoint,
        } => nemoclaw_docker::credentials::Source::OllamaProxy {
            storage: storage.clone(),
            container: container.clone(),
            endpoint: endpoint.clone(),
        },
        Source::ManagedService {
            storage,
            container,
            endpoint,
        } => nemoclaw_docker::credentials::Source::ManagedService {
            storage: storage.clone(),
            container: container.clone(),
            endpoint: endpoint.clone(),
        },
    };
    nemoclaw_docker::credentials::resolve(&source).await
}
