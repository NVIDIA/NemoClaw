// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm, voiceclaw};
use crate::{CancellationToken, Error, docker::Connections, managed::Spec};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum ProxyReadiness {
    #[serde(rename = "voiceclaw")]
    Voiceclaw { spec: Box<Spec> },
    #[serde(rename = "ollama_proxy")]
    Proxy {
        engine: String,
        proxy: Box<ollama::ProxySpec>,
    },
}
enum ReadinessSpec {
    Managed(Box<Spec>),
    Proxy(ProxyReadiness),
}
impl ReadinessSpec {
    fn engine(&self) -> &str {
        match self {
            Self::Managed(spec) => spec.engine(),
            Self::Proxy(ProxyReadiness::Proxy { engine, .. }) => engine,
            Self::Proxy(ProxyReadiness::Voiceclaw { spec }) => spec.engine(),
        }
    }
}

pub(crate) fn configure_service_readiness(
    graph: &mut Value,
    targets: &[crate::compile::Target],
    document: &crate::config::Document,
) -> Result<(), Error> {
    voiceclaw::configure_readiness(graph, targets, document)?;
    for target in targets
        .iter()
        .filter(|target| target.kind == ollama::proxy::PROXY)
    {
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let address = format!("data.nemoclaw_service_readiness.{logical}");
        let mut proxy = ollama::proxy::row_spec(&target.values)?;
        proxy.image_pull_policy = None;
        let encoded = json!({"kind":ollama::proxy::PROXY,"engine":target.values["engine"],
            "proxy":proxy})
        .to_string();
        graph["data"]["nemoclaw_service_readiness"][logical] = json!({
            "spec":encoded.replace("${", "$${").replace("%{", "%%{"),
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}", "wait_timeout_seconds":30
        });
        for instances in graph["resource"].as_object_mut().unwrap().values_mut() {
            for resource in instances.as_object_mut().unwrap().values_mut() {
                if let Some(dependencies) = resource["depends_on"].as_array_mut()
                    && dependencies.contains(&json!(container))
                {
                    dependencies.push(json!(address));
                }
            }
        }
    }
    Ok(())
}

fn parse(encoded: &str) -> Result<ReadinessSpec, Error> {
    if let Ok(proxy) = serde_json::from_str::<ProxyReadiness>(encoded) {
        match &proxy {
            ProxyReadiness::Proxy {
                engine,
                proxy: spec,
            } => {
                crate::docker::Engine::validate_endpoint(engine)?;
                spec.validate()?;
            }
            ProxyReadiness::Voiceclaw { spec } => voiceclaw::validate_readiness(spec)?,
        }
        return Ok(ReadinessSpec::Proxy(proxy));
    }
    let spec: Spec = serde_json::from_str(encoded)
        .map_err(|_| Error::State("invalid service readiness specification"))?;
    if !matches!(spec.kind.as_str(), "inference_service" | "ollama_service") {
        return Err(Error::State("runtime has no service readiness contract"));
    }
    super::validate_resource_spec(&spec.kind, encoded)?;
    Ok(ReadinessSpec::Managed(Box::new(spec)))
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
        let spec = match &spec {
            ReadinessSpec::Managed(spec) => spec,
            ReadinessSpec::Proxy(ProxyReadiness::Voiceclaw { spec }) => {
                return voiceclaw::wait_ready(&engine, spec, container_id, timeout).await;
            }
            ReadinessSpec::Proxy(ProxyReadiness::Proxy { proxy, .. }) => {
                let observed = engine
                    .container(container_id)
                    .await?
                    .ok_or(Error::State("proxy runtime is absent"))?;
                if observed.id.as_deref() != Some(container_id)
                    || observed
                        .name
                        .as_deref()
                        .map(|name| name.trim_start_matches('/'))
                        != Some(proxy.name.as_str())
                {
                    return Err(crate::ObservationError::BindingMismatch.into());
                }
                if !observed
                    .state
                    .and_then(|state| state.running)
                    .unwrap_or(false)
                {
                    return Err(Error::State(
                        "proxy runtime is not running; explicitly reapply",
                    ));
                }
                if timeout.is_zero() {
                    super::authentication::read_key(&engine, container_id).await?;
                } else {
                    super::authentication::read_proxy_key(&engine, container_id).await?;
                }
                ollama::proxy::verify_model(&proxy.settings).await?;
                return Ok(());
            }
        };
        loop {
            let observed = engine
                .observe_service(spec, container_id)
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
                        && vllm::configured_service(spec)?.authentication.is_some()
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
