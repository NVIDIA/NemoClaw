// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{CancellationToken, Error, docker::Connections};
use nemoclaw_runtime::RuntimeSpec;
use std::time::Duration;

/// The contract a ready container serves, as a runtime contract data source computes it.
enum Contract {
    Runtime(Box<RuntimeSpec>),
    Proxy(ollama::ProxySettings),
}

/// A service container whose readiness a check waits for.
pub struct Readiness {
    engine: String,
    name: String,
    contract: Contract,
}

impl Readiness {
    /// Validate readiness inputs without contacting hosts.
    ///
    /// # Errors
    /// Returns an error naming the invalid input.
    pub fn new(engine: &str, name: &str, contract: &str) -> Result<Self, Error> {
        crate::config::validate_engine_endpoint(engine)?;
        if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$")
            .unwrap()
            .is_match(name)
        {
            return Err(Error::Conflict(
                "name must be a container name of letters, digits, underscores, periods, or hyphens",
            ));
        }
        // Runtime contracts name their kind; the Ollama proxy contract does not.
        let tagged = serde_json::from_str::<serde_json::Value>(contract)
            .map_err(|_| Error::Conflict("contract must be a runtime contract data source's spec"))?
            .get("kind")
            .is_some();
        let contract = if tagged {
            Contract::Runtime(Box::new(RuntimeSpec::decode(contract)?))
        } else {
            Contract::Proxy(ollama::ProxySettings::decode(contract)?)
        };
        Ok(Self {
            engine: engine.into(),
            name: name.into(),
            contract,
        })
    }
}

pub async fn wait_service_ready(
    connections: &Connections,
    readiness: &Readiness,
    container_id: &str,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    if container_id.is_empty() {
        return Err(Error::State(
            "service readiness requires a container identity",
        ));
    }
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let engine = crate::managed::service_engine(connections, &readiness.engine)?;
    // The container must be the declared one; its start time orders status reports.
    let observe = || async {
        let observed =
            tokio::time::timeout(Duration::from_secs(20), engine.container(container_id))
                .await
                .map_err(|_| crate::ObservationError::Transport)??;
        let Some(observed) = observed else {
            return Ok(None);
        };
        if observed.id.as_deref() != Some(container_id)
            || observed
                .name
                .as_deref()
                .map(|name| name.trim_start_matches('/'))
                != Some(readiness.name.as_str())
        {
            return Err(crate::ObservationError::BindingMismatch.into());
        }
        let state = observed.state.ok_or(crate::ObservationError::Incomplete)?;
        Ok::<_, Error>(Some((
            state.running.ok_or(crate::ObservationError::Incomplete)?,
            state.started_at.filter(|value| !value.is_empty()),
        )))
    };
    let check = async {
        let spec = match &readiness.contract {
            Contract::Runtime(spec) => spec,
            Contract::Proxy(settings) => {
                let (running, _) = observe()
                    .await?
                    .ok_or(Error::State("proxy runtime is absent"))?;
                if !running {
                    return Err(Error::State("proxy runtime is not running; reapply"));
                }
                if timeout.is_zero() {
                    super::authentication::read_key(&engine, container_id).await?;
                } else {
                    super::authentication::read_proxy_key(&engine, container_id).await?;
                }
                ollama::proxy::verify_model(settings).await?;
                return Ok(());
            }
        };
        let (kind, authenticated) = match spec.as_ref() {
            RuntimeSpec::Vllm(service) => (vllm::SERVICE_KIND, service.authentication.is_some()),
            RuntimeSpec::Ollama(_) => (ollama::SERVICE_KIND, false),
        };
        loop {
            let (running, started_at) = observe()
                .await?
                .ok_or(Error::State("service runtime is unobservable"))?;
            if !running {
                return Err(Error::State(
                    "service stopped during readiness; inspect logs and reapply",
                ));
            }
            let started_at = started_at.ok_or(crate::ObservationError::Incomplete)?;
            let phase = super::status::phase(&engine, kind, container_id, &started_at).await?;
            match phase.as_str() {
                "ready" => {
                    if authenticated {
                        super::authentication::read_service_key(&engine, container_id).await?;
                    }
                    return Ok(());
                }
                "stopped" => {
                    return Err(Error::State(
                        "service protection stopped the runtime; reapply is required",
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
