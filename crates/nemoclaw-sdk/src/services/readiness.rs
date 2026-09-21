// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{CancellationToken, Error, docker::Connections, managed::Spec};
use std::time::Duration;

fn parse(encoded: &str) -> Result<Spec, Error> {
    let spec: Spec = serde_json::from_str(encoded)
        .map_err(|_| Error::State("invalid service readiness specification"))?;
    if !matches!(spec.kind.as_str(), "inference_service" | "ollama_service") {
        return Err(Error::State("runtime has no service readiness contract"));
    }
    super::validate_resource_spec(&spec.kind, encoded)?;
    Ok(spec)
}

/// Validate readiness inputs without contacting an engine or loading credentials.
pub fn validate_readiness_spec(encoded: &str) -> Result<(), Error> {
    parse(encoded).map(|_| ())
}

/// Observe application readiness for one explicit provider container identity.
/// Only startup phases are polled; failed observations and protection stops fail immediately.
/// This performs no mutations, hardware preflights, or model requests.
pub async fn wait_service_ready(
    connections: &Connections,
    encoded: &str,
    container_id: &str,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    let spec = parse(encoded)?;
    if container_id.is_empty() {
        return Err(Error::State(
            "service readiness requires a container identity",
        ));
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let engine = crate::managed::service_engine(connections, spec.engine())?;
    let check = async {
        loop {
            let observed = engine
                .observe_service(&spec, container_id)
                .await?
                .ok_or(Error::State("service runtime is unobservable"))?;
            if !observed.running {
                return Err(Error::State(
                    "service stopped during readiness; inspect logs and explicitly reapply",
                ));
            }
            let phase = if spec.kind == ollama::SERVICE_KIND {
                ollama::artifacts::runtime_status(&engine, &observed)
                    .await?
                    .phase
            } else {
                engine.runtime_status(&observed).await?.phase
            };
            match phase.as_str() {
                "ready" => {
                    if spec.kind == vllm::SERVICE_KIND
                        && vllm::configured_service(&spec)?.authentication.is_some()
                    {
                        super::authentication::read_service_key(&engine, container_id).await?;
                    }
                    return Ok(());
                }
                "stopped" => {
                    return Err(Error::State(
                        "service protection stopped the runtime; explicit reapply is required",
                    ));
                }
                _ if timeout.is_zero() => return Err(Error::State("service is not ready")),
                _ => tokio::time::sleep(Duration::from_secs(5)).await,
            }
        }
    };
    tokio::select! {
        () = cancel.cancelled() => Err(Error::Cancelled),
        result = async {
            if timeout.is_zero() { check.await } else {
                tokio::time::timeout(timeout, check).await
                    .map_err(|_| Error::State("service readiness check timed out"))?
            }
        } => result,
    }
}
