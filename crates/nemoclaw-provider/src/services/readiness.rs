// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::installers::{ollama, vllm};
use crate::{CancellationToken, Error, docker::Connections, managed::Spec};
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum ProxyReadiness {
    #[serde(rename = "ollama_proxy")]
    Proxy {
        engine: String,
        proxy: Box<ollama::ProxySpec>,
    },
}

#[cfg(all(test, unix))]
mod container_tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use serde_json::json;

    fn application() -> (Spec, serde_json::Value) {
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../managed/reference.json")).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap();
        value["kind"] = json!("container_service");
        value["process"]["configuration"] = json!("");
        value["process"]["entrypoint"] = json!([]);
        value["process"]["command"] = json!([]);
        value["process"]["gpu"] = json!(false);
        value["process"]["host_ipc"] = json!(false);
        value["process"]["user"] = json!("65532:65532");
        value["process"]["mount_target"] = json!("/var/lib/voiceclaw");
        value["process"]["memory_bytes"] = json!(1_u64 << 30);
        value["process"]["shared_memory_bytes"] = json!(64_u64 << 20);
        let spec: Spec = serde_json::from_value(value.clone()).unwrap();
        (spec, value)
    }

    #[tokio::test]
    async fn container_readiness_observes_health_without_exec_or_mutation() {
        let (spec, value) = application();
        for (health, running, expected) in [
            ("healthy", true, true),
            ("unhealthy", true, false),
            ("starting", true, false),
            ("", true, false),
            ("healthy", false, false),
        ] {
            let name = spec.name.clone();
            let labels = spec.labels().unwrap();
            let fixture = Fixture::start(move |request| {
                assert_eq!(request.method, "GET");
                assert_eq!(request.path, "/containers/provider-container/json");
                Some((200, serde_json::to_vec(&json!({"Id":"provider-container", "Name":format!("/{name}"),"Config":{"Labels":labels},"State":{"Running":running,"Health":{"Status":health}}})).unwrap()))
            }).await;
            let connections = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
            let result = wait_service_ready(
                &connections,
                &value.to_string(),
                "provider-container",
                Duration::ZERO,
                &CancellationToken::new(),
            )
            .await;
            assert_eq!(result.is_ok(), expected, "{health} {running}: {result:?}");
        }
    }

    #[tokio::test]
    async fn container_readiness_rejects_wrong_identity_and_unknown_observations() {
        let (spec, encoded) = application();
        for variant in [
            "id",
            "name",
            "owner",
            "generation",
            "configuration",
            "missing-state",
            "missing-health",
            "absent",
            "authentication",
            "transport",
            "starting",
        ] {
            let mut body = json!({"Id":"provider-container","Name":format!("/{}",spec.name),"Config":{"Labels":spec.labels().unwrap()},"State":{"Running":true,"Health":{"Status":"healthy"}}});
            match variant {
                "id" => body["Id"] = json!("other-container"),
                "name" => body["Name"] = json!("/other-container"),
                "owner" => {
                    body["Config"]["Labels"][crate::managed::OWNER_LABEL] =
                        json!("PRIVATE_SENTINEL")
                }
                "generation" => {
                    body["Config"]["Labels"][crate::managed::GENERATION_LABEL] =
                        json!("PRIVATE_SENTINEL")
                }
                "configuration" => {
                    body["Config"]["Labels"][nemoclaw_sdk::managed::SPEC_LABEL] =
                        json!("PRIVATE_SENTINEL")
                }
                "missing-state" => body["State"] = json!({}),
                "missing-health" => body["State"] = json!({"Running":true}),
                "starting" => body["State"]["Health"]["Status"] = json!("starting"),
                _ => {}
            }
            let status = match variant {
                "absent" => 404,
                "authentication" => 401,
                "transport" => 500,
                _ => 200,
            };
            let fixture = Fixture::start(move |request| {
                assert_eq!(request.method, "GET");
                assert_eq!(request.path, "/containers/provider-container/json");
                Some((status, serde_json::to_vec(&body).unwrap()))
            })
            .await;
            let connections = Connections::fixed([fixture.engine_for(spec.engine())]).unwrap();
            let error = wait_service_ready(
                &connections,
                &encoded.to_string(),
                "provider-container",
                Duration::from_millis(50),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
            assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
            if variant == "starting" {
                assert!(error.to_string().contains("timed out"));
            }
            let cancel = CancellationToken::new();
            cancel.cancel();
            assert!(matches!(
                wait_service_ready(
                    &connections,
                    &encoded.to_string(),
                    "provider-container",
                    Duration::ZERO,
                    &cancel
                )
                .await,
                Err(Error::Cancelled)
            ));
        }
        for (field, value) in [
            ("user", json!("0:0")),
            ("gpu", json!(true)),
            ("host_ipc", json!(true)),
            ("entrypoint", json!(["sh"])),
            ("image", json!("application:latest")),
            ("engine", json!("ssh://host")),
            ("architecture", json!("native")),
            ("mount_target", json!("/var/lib/../etc")),
        ] {
            let mut bad = encoded.clone();
            bad["process"][field] = value;
            assert!(
                validate_readiness_spec(&bad.to_string()).is_err(),
                "accepted {field}"
            );
        }
    }
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
        }
    }
}

fn parse(encoded: &str) -> Result<ReadinessSpec, Error> {
    if let Ok(proxy) = serde_json::from_str::<ProxyReadiness>(encoded) {
        let ProxyReadiness::Proxy {
            engine,
            proxy: spec,
        } = &proxy;
        crate::config::validate_engine_endpoint(engine)?;
        spec.validate()?;
        return Ok(ReadinessSpec::Proxy(proxy));
    }
    let spec: Spec = serde_json::from_str(encoded)
        .map_err(|_| Error::State("invalid service readiness specification"))?;
    if !matches!(
        spec.kind.as_str(),
        "inference_service" | "ollama_service" | "container_service"
    ) {
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
            if spec.kind == nemoclaw_sdk::services::installers::container::SERVICE_KIND {
                if container_health(&engine, spec, container_id).await? {
                    return Ok(());
                }
                if timeout.is_zero() {
                    return Err(Error::State("container is not ready"));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
            let observed = engine
                .observe_service(spec, container_id)
                .await?
                .ok_or(Error::State("service runtime is unobservable"))?;
            if !observed.running {
                return Err(Error::State(
                    "service stopped during readiness; inspect logs and explicitly reapply",
                ));
            }
            let phase = super::status::runtime_phase(&engine, &observed).await?;
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

async fn container_health(
    engine: &crate::docker::Engine,
    spec: &Spec,
    id: &str,
) -> Result<bool, Error> {
    let expected_labels = spec.labels()?;
    let container = tokio::time::timeout(Duration::from_secs(20), engine.container(id))
        .await
        .map_err(|_| crate::ObservationError::Transport)??
        .ok_or(Error::State("container runtime is unobservable"))?;
    if container.id.as_deref() != Some(id)
        || container
            .name
            .as_deref()
            .map(|name| name.trim_start_matches('/'))
            != Some(spec.name.as_str())
        || container
            .config
            .as_ref()
            .and_then(|config| config.labels.as_ref())
            .is_none_or(|labels| {
                expected_labels
                    .iter()
                    .any(|(key, value)| labels.get(key) != Some(value))
            })
    {
        return Err(crate::ObservationError::BindingMismatch.into());
    }
    let state = container.state.ok_or(crate::ObservationError::Incomplete)?;
    if state.running != Some(true) {
        return Err(Error::State("container is not running; explicitly reapply"));
    }
    let health = state
        .health
        .and_then(|health| health.status)
        .ok_or(Error::State(
            "container has no observable Docker HEALTHCHECK",
        ))?;
    match health.to_string().as_str() {
        "healthy" => Ok(true),
        "starting" => Ok(false),
        "unhealthy" => Err(Error::State(
            "container HEALTHCHECK failed; inspect application logs",
        )),
        _ => Err(Error::State("container health observation is unknown")),
    }
}
