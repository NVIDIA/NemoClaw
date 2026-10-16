// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! `host_container_health`: whether an owned container reports a healthy
//! Docker HEALTHCHECK, HTTP endpoint, or managed-runtime status file.
//! It never executes a command in the container.
use crate::{Error, ObservationError, docker::Connections, provider::ConfiguredBackend};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

pub(crate) struct HostContainerHealthDataSource(pub Arc<ConfiguredBackend>);
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct HostContainerHealthState {
    engine: Value<String>,
    name: Value<String>,
    container_id: Value<String>,
    labels: Value<BTreeMap<String, Value<String>>>,
    http_url: Value<String>,
    runtime_status: Value<String>,
    wait_timeout_seconds: Value<u64>,
    read_trigger: Value<bool>,
    healthy: Value<bool>,
}

/// The container a read must find.
struct Expected {
    engine: String,
    name: String,
    id: String,
    labels: BTreeMap<String, String>,
    http_url: Option<String>,
    runtime_status: Option<String>,
    wait: Duration,
}

impl Expected {
    /// The expected container; an error while any input is unknown or missing.
    fn from_state(config: &HostContainerHealthState) -> Result<Self, Error> {
        let text = |value: &Value<String>| match value {
            Value::Value(value) if !value.is_empty() => Ok(value.clone()),
            _ => Err(Error::State("container health inputs are not yet known")),
        };
        let labels = match &config.labels {
            Value::Null => BTreeMap::new(),
            Value::Value(labels) => labels
                .iter()
                .map(|(key, value)| Ok((key.clone(), text(value)?)))
                .collect::<Result<_, Error>>()?,
            Value::Unknown => {
                return Err(Error::State("container health inputs are not yet known"));
            }
        };
        let wait = match config.wait_timeout_seconds {
            Value::Value(seconds) => seconds.min(3600),
            Value::Null => 0,
            Value::Unknown => {
                return Err(Error::State("container health inputs are not yet known"));
            }
        };
        let engine = text(&config.engine)?;
        crate::config::validate_engine_endpoint(&engine)?;
        let optional = |value: &Value<String>| match value {
            Value::Null => Ok(None),
            _ => text(value).map(Some),
        };
        let http_url = optional(&config.http_url)?;
        let runtime_status = optional(&config.runtime_status)?;
        if http_url.is_some() && runtime_status.is_some() {
            return Err(Error::State(
                "choose HTTP or runtime status readiness, not both",
            ));
        }
        if let Some(url) = &http_url {
            let url =
                url::Url::parse(url).map_err(|_| Error::State("invalid container health URL"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(Error::State(
                    "container health URL must not contain credentials, query, or fragment",
                ));
            }
        }
        if runtime_status.as_ref().is_some_and(|path| {
            !path.starts_with('/')
                || path.contains('\0')
                || path.split('/').any(|part| matches!(part, "." | ".."))
        }) {
            return Err(Error::State(
                "runtime status requires an absolute path without traversal",
            ));
        }
        Ok(Self {
            engine,
            name: text(&config.name)?,
            id: text(&config.container_id)?,
            labels,
            http_url,
            runtime_status,
            wait: Duration::from_secs(wait),
        })
    }
}

/// Whether the container is healthy: `false` while its health check starts.
async fn observe(
    connections: &Connections,
    expected: &Expected,
    client: &reqwest::Client,
) -> Result<bool, Error> {
    let container = tokio::time::timeout(
        Duration::from_secs(20),
        connections
            .resolve(&expected.engine)?
            .container(&expected.id),
    )
    .await
    .map_err(|_| ObservationError::Transport)??
    .ok_or(Error::State("container is absent; reapply"))?;
    let labels = container
        .config
        .as_ref()
        .and_then(|config| config.labels.as_ref());
    if container.id.as_deref() != Some(expected.id.as_str())
        || container
            .name
            .as_deref()
            .map(|name| name.trim_start_matches('/'))
            != Some(expected.name.as_str())
        || expected
            .labels
            .iter()
            .any(|(key, value)| labels.and_then(|labels| labels.get(key)) != Some(value))
    {
        return Err(ObservationError::BindingMismatch.into());
    }
    let state = container.state.ok_or(ObservationError::Incomplete)?;
    if state.running != Some(true) {
        return Err(Error::State("container is not running; reapply"));
    }
    if let Some(path) = &expected.runtime_status {
        #[derive(Deserialize)]
        struct Status {
            phase: String,
            updated: String,
            #[serde(rename = "detail")]
            _detail: String,
            #[serde(rename = "pid")]
            _pid: u32,
        }
        let Some(bytes) = connections
            .resolve(&expected.engine)?
            .read_file(&expected.id, path, 128 << 10)
            .await?
        else {
            return Ok(false);
        };
        let status: Status = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("runtime status is incomplete"))?;
        let parse_time = |value: &str| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                .map_err(|_| Error::State("runtime status timestamp is incomplete"))
        };
        let start = state
            .started_at
            .as_deref()
            .ok_or(ObservationError::Incomplete)?;
        if parse_time(&status.updated)? < parse_time(start)? {
            return Ok(false);
        }
        return match status.phase.as_str() {
            "ready" => Ok(true),
            "initializing" | "downloading" | "preparing" | "loading" => Ok(false),
            "stopped" => Err(Error::State("managed runtime stopped; resources retained")),
            _ => Err(Error::State("unknown managed runtime status")),
        };
    }
    if let Some(url) = &expected.http_url {
        return match client.get(url).send().await {
            Ok(response) if response.status() == reqwest::StatusCode::OK => Ok(true),
            Ok(response)
                if response.status().is_redirection() || response.status().is_client_error() =>
            {
                Err(Error::State("container health endpoint rejected the read"))
            }
            _ => Ok(false),
        };
    }
    match state
        .health
        .and_then(|health| health.status)
        .map(|s| s.to_string())
        .as_deref()
    {
        Some("healthy") => Ok(true),
        Some("starting") => Ok(false),
        Some("unhealthy") => Err(Error::State(
            "container health check failed; inspect its logs",
        )),
        _ => Err(Error::State("container has no Docker HEALTHCHECK")),
    }
}

async fn wait_healthy(connections: &Connections, expected: &Expected) -> Result<(), Error> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Error::State("cannot create container health client"))?;
    if expected.wait.is_zero() {
        return if observe(connections, expected, &client).await? {
            Ok(())
        } else {
            Err(Error::State("container health check is still starting"))
        };
    }
    tokio::time::timeout(expected.wait, async {
        while !observe(connections, expected, &client).await? {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Ok(())
    })
    .await
    .map_err(|_| Error::State("container readiness timed out; resources retained"))?
}

#[async_trait]
impl DataSource for HostContainerHealthDataSource {
    type State<'a> = HostContainerHealthState;
    type ProviderMetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        use AttributeConstraint::{Computed, Optional, Required};
        use AttributeType::{Bool, Map, Number, String};
        Some(Schema {
            version: 0,
            block: Block {
                attributes: [
                    ("engine", String, Required),
                    ("name", String, Required),
                    ("container_id", String, Required),
                    ("labels", Map(Box::new(String)), Optional),
                    ("http_url", String, Optional),
                    ("runtime_status", String, Optional),
                    ("wait_timeout_seconds", Number, Optional),
                    ("read_trigger", Bool, Optional),
                    ("healthy", Bool, Computed),
                ]
                .into_iter()
                .map(|(name, attr_type, constraint)| {
                    (
                        name.into(),
                        Attribute {
                            attr_type,
                            constraint,
                            ..Default::default()
                        },
                    )
                })
                .collect(),
                ..Default::default()
            },
        })
    }
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: HostContainerHealthState,
        _: ValueEmpty,
    ) -> Option<HostContainerHealthState> {
        let work = async {
            let expected = Expected::from_state(&config)?;
            if matches!(config.read_trigger, Value::Unknown) {
                return Err(Error::State("container readiness trigger is not yet known"));
            }
            wait_healthy(self.0.connections(), &expected).await
        };
        match work.await {
            Ok(()) => {
                config.healthy = Value::Value(true);
                Some(config)
            }
            Err(error) => {
                diags.root_error("Container health observation failed", error.to_string());
                None
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use serde_json::json;

    #[tokio::test]
    async fn runtime_status_requires_a_ready_report_from_the_current_container_start() {
        for (phase, updated, ready) in [
            ("ready", "2026-01-02T00:00:01Z", true),
            ("ready", "2026-01-01T00:00:00Z", false),
            ("loading", "2026-01-02T00:00:01Z", false),
            ("stopped", "2026-01-02T00:00:01Z", false),
            ("PRIVATE_SENTINEL", "2026-01-02T00:00:01Z", false),
        ] {
            let fixture = Fixture::engine(move |request| {
                assert_eq!(request.method, "GET");
                if request.path.ends_with("/json") {
                    Some((
                        200,
                        serde_json::to_vec(&json!({"Id":"runtime", "Name":"/model",
                        "State":{"Running":true,"StartedAt":"2026-01-02T00:00:00Z"}}))
                        .unwrap(),
                    ))
                } else {
                    assert!(request.path.starts_with("/containers/runtime/archive?"));
                    let bytes = serde_json::to_vec(
                        &json!({"phase":phase,"updated":updated,"detail":"","pid":42}),
                    )
                    .unwrap();
                    Some((
                        200,
                        nemoclaw_docker::archive(&[("status.json", &bytes, 0o600)]).unwrap(),
                    ))
                }
            })
            .await;
            let connections =
                Connections::fixed([fixture.engine_for("unix:///docker.sock")]).unwrap();
            let expected = Expected {
                engine: "unix:///docker.sock".into(),
                name: "model".into(),
                id: "runtime".into(),
                labels: BTreeMap::new(),
                wait: Duration::ZERO,
                http_url: None,
                runtime_status: Some("/data/status.json".into()),
            };
            let result = wait_healthy(&connections, &expected).await;
            assert_eq!(result.is_ok(), ready);
            assert!(!format!("{result:?}").contains("PRIVATE_SENTINEL"));
        }
    }

    #[tokio::test]
    async fn http_readiness_uses_status_not_container_liveness_or_redirects() {
        let engine = Fixture::engine(|request| {
            assert_eq!(request.method, "GET");
            Some((
                200,
                serde_json::to_vec(&json!({"Id":"web", "Name":"/web", "State":{"Running":true}}))
                    .unwrap(),
            ))
        })
        .await;
        let connections = Connections::fixed([engine.engine_for("unix:///docker.sock")]).unwrap();
        for status in [200, 503, 302, 401] {
            let endpoint = Fixture::start_tcp(move |request| {
                assert_eq!(
                    (request.method.as_str(), request.path.as_str()),
                    ("GET", "/health")
                );
                Some((status, b"PRIVATE_SENTINEL".to_vec()))
            })
            .await;
            let expected = Expected {
                engine: "unix:///docker.sock".into(),
                name: "web".into(),
                id: "web".into(),
                labels: BTreeMap::new(),
                wait: Duration::ZERO,
                runtime_status: None,
                http_url: Some(format!("{}/health", endpoint.endpoint)),
            };
            let result = wait_healthy(&connections, &expected).await;
            assert_eq!(result.is_ok(), status == 200);
            assert!(!format!("{result:?}").contains("PRIVATE_SENTINEL"));
        }
    }

    #[tokio::test]
    async fn only_a_running_healthy_owned_container_is_healthy() {
        let engine = "unix:///var/run/docker.sock";
        let expected = Expected {
            engine: engine.into(),
            name: "application".into(),
            id: "application-id".into(),
            labels: BTreeMap::from([("owner".into(), "deployment".into())]),
            http_url: None,
            runtime_status: None,
            wait: Duration::ZERO,
        };
        let container = |health: &str, running: bool| {
            json!({"Id":"application-id","Name":"/application","Config":{"Labels":{"owner":"deployment"}},
                "State":{"Running":running,"Health":{"Status":health}}})
        };
        let mut foreign = container("healthy", true);
        foreign["Config"]["Labels"]["owner"] = json!("PRIVATE_SENTINEL");
        for (status, body, healthy) in [
            (200, container("healthy", true), true),
            (200, container("starting", true), false),
            (200, container("unhealthy", true), false),
            (200, container("healthy", false), false),
            (200, foreign, false),
            (404, json!({}), false),
        ] {
            let fixture = Fixture::engine(move |request| {
                assert_eq!(request.method, "GET");
                Some((status, serde_json::to_vec(&body).unwrap()))
            })
            .await;
            let connections = Connections::fixed([fixture.engine_for(engine)]).unwrap();
            let result = wait_healthy(&connections, &expected).await;
            assert_eq!(result.is_ok(), healthy, "{status} {result:?}");
            if let Err(error) = result {
                assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
            }
        }
    }
}
