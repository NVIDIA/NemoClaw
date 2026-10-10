// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    Error, ObservationError,
    docker::{Connections, Engine},
    managed::OWNER_LABEL,
};
use bollard::models::ContainerStateStatusEnum;
use std::{future::Future, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Failure {
    Observation(ObservationError),
    Stopped {
        status: &'static str,
        exit_code: Option<i64>,
    },
}
impl From<ObservationError> for Failure {
    fn from(error: ObservationError) -> Self {
        Self::Observation(error)
    }
}
impl Failure {
    pub(super) fn message(self, name: &str) -> String {
        match self {
            Self::Observation(error) => {
                format!("gateway container {name}: {error}; resources retained")
            }
            Self::Stopped { status, exit_code } => format!(
                "gateway container {name} is {status}, exit code {}; inspect `docker logs {name}` on its configured engine, correct the failure, and reapply; resources retained",
                exit_code.map_or_else(|| "unknown".into(), |code| code.to_string())
            ),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Running,
    Restarting,
    Stopped(Failure),
}

/// A managed gateway container bound by its engine, ID, name, and owner label.
pub(super) struct ManagedGateway {
    engine: Engine,
    id: String,
    name: String,
    owner: String,
}
impl ManagedGateway {
    pub(super) fn new(
        engine: &str,
        id: &str,
        name: &str,
        owner: &str,
        connections: &Connections,
    ) -> Result<Self, ObservationError> {
        let engine = connections
            .resolve(engine)
            .map_err(Error::into_observation)?;
        Ok(Self {
            engine,
            id: id.into(),
            name: name.into(),
            owner: owner.into(),
        })
    }
    pub(super) fn name(&self) -> &str {
        &self.name
    }

    async fn phase(&self) -> Result<Phase, Failure> {
        let container =
            tokio::time::timeout(Duration::from_secs(20), self.engine.container(&self.id))
                .await
                .map_err(|_| ObservationError::Transport)?
                .map_err(Error::into_observation)?;
        let Some(container) = container else {
            return Ok(Phase::Stopped(Failure::Stopped {
                status: "absent",
                exit_code: None,
            }));
        };
        if container.id.as_deref() != Some(self.id.as_str())
            || container
                .name
                .as_deref()
                .map(|name| name.trim_start_matches('/'))
                != Some(self.name())
            || container
                .config
                .as_ref()
                .and_then(|config| config.labels.as_ref())
                .and_then(|labels| labels.get(OWNER_LABEL))
                != Some(&self.owner)
        {
            return Err(ObservationError::BindingMismatch.into());
        }
        let state = container.state.ok_or(ObservationError::Incomplete)?;
        let running = state.running.ok_or(ObservationError::Incomplete)?;
        use ContainerStateStatusEnum::*;
        let status = match state.status.ok_or(ObservationError::Incomplete)? {
            RUNNING if running => return Ok(Phase::Running),
            RESTARTING => return Ok(Phase::Restarting),
            CREATED if !running => "created",
            EXITED if !running => "exited",
            DEAD if !running => "dead",
            PAUSED => "paused",
            _ => return Err(ObservationError::Incomplete.into()),
        };
        Ok(Phase::Stopped(Failure::Stopped {
            status,
            exit_code: state.exit_code,
        }))
    }

    pub(super) async fn observe<T, F: Future<Output = Result<T, ObservationError>>>(
        &self,
        timeout: Duration,
        observe: impl FnMut() -> F,
    ) -> Result<T, Failure> {
        let work = async {
            let request = super::observe_with_wait(timeout, observe);
            tokio::pin!(request);
            let mut previous = None;
            loop {
                let phase = self.phase().await?;
                if let Phase::Stopped(error) = phase
                    && (timeout.is_zero() || previous == Some(phase))
                {
                    return Err(error);
                }
                previous = Some(phase);
                if phase == Phase::Running {
                    // Keep one in-flight gateway request while checking the engine.
                    // A stalled API cannot hide a process that exits during startup.
                    tokio::select! {
                        result = &mut request => return result.map_err(Failure::from),
                        () = tokio::time::sleep(Duration::from_millis(200)) => {}
                    }
                } else if timeout.is_zero() {
                    return Err(ObservationError::Transport.into());
                } else {
                    // Confirm a terminal observation once across a restart race.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        };
        if timeout.is_zero() {
            work.await
        } else {
            tokio::time::timeout(timeout, work)
                .await
                .unwrap_or(Err(ObservationError::Transport.into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docker::fixture::Fixture;
    use serde_json::{Value, json};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    fn spec() -> crate::managed::Spec {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../managed/reference.json")).unwrap();
        serde_json::from_str(fixtures[0]["spec"].as_str().unwrap()).unwrap()
    }
    fn container(spec: &crate::managed::Spec) -> Value {
        json!({"Id":"bound", "Name":format!("/{}",spec.name),
            "Config":{"Labels":{OWNER_LABEL:spec.owner},"Env":["KEY=PRIVATE_SENTINEL"]},
            "State":{"Status":"running","Running":true,"ExitCode":0,"Error":"PRIVATE_SENTINEL"}})
    }
    async fn observer(
        mut response: impl FnMut() -> (u16, Value) + Send + 'static,
    ) -> (Fixture, ManagedGateway) {
        let fixture = Fixture::engine(move |request| {
            assert_eq!(
                request.method, "GET",
                "readiness must not mutate the engine"
            );
            assert_eq!(
                request.path, "/containers/bound/json",
                "read only the bound container"
            );
            let (status, value) = response();
            Some((status, serde_json::to_vec(&value).unwrap()))
        })
        .await;
        let spec = spec();
        let managed = ManagedGateway::new(
            &fixture.endpoint,
            "bound",
            &spec.name,
            &spec.owner,
            &Connections::default(),
        )
        .unwrap();
        (fixture, managed)
    }

    #[tokio::test]
    async fn a_process_exit_interrupts_an_already_pending_gateway_request() {
        let running = container(&spec());
        let reads = Arc::new(AtomicUsize::new(0));
        let count = reads.clone();
        let (_fixture, gateway) = observer(move || {
            let mut value = running.clone();
            if count.fetch_add(1, Ordering::SeqCst) != 0 {
                value["State"] = json!({"Running":false,"Status":"exited","ExitCode":23});
            }
            (200, value)
        })
        .await;
        let requests = AtomicUsize::new(0);
        let error = tokio::time::timeout(
            Duration::from_secs(2),
            gateway.observe::<(), _>(Duration::from_secs(90), || {
                requests.fetch_add(1, Ordering::SeqCst);
                std::future::pending()
            }),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert_eq!(
            error,
            Failure::Stopped {
                status: "exited",
                exit_code: Some(23)
            }
        );
        assert_eq!(
            requests.load(Ordering::SeqCst),
            1,
            "do not restart an in-flight API request on each engine poll"
        );
        assert!(reads.load(Ordering::SeqCst) >= 3);
    }

    #[tokio::test]
    async fn a_restart_race_can_recover_but_a_running_unreachable_gateway_stays_transport() {
        for initial in ["exited", "restarting"] {
            let running = container(&spec());
            let mut first = true;
            let (_fixture, gateway) = observer(move || {
                let mut value = running.clone();
                if first {
                    first = false;
                    value["State"] = json!({"Running":false,"Status":initial,"ExitCode":1});
                }
                (200, value)
            })
            .await;
            assert_eq!(
                gateway
                    .observe(Duration::from_secs(2), || std::future::ready(Ok("ready")))
                    .await
                    .unwrap(),
                "ready"
            );
        }
        let running = container(&spec());
        let (_fixture, gateway) = observer(move || (200, running.clone())).await;
        let error = gateway
            .observe::<(), _>(Duration::from_millis(500), || {
                std::future::ready(Err(ObservationError::Transport))
            })
            .await
            .unwrap_err();
        assert_eq!(error, Failure::Observation(ObservationError::Transport));
    }

    #[tokio::test]
    async fn process_observation_preserves_access_identity_and_incomplete_failures() {
        let baseline = container(&spec());
        let mut cases = Vec::new();
        for field in ["Id", "Name", "owner"] {
            let mut value = baseline.clone();
            if field == "owner" {
                value["Config"]["Labels"][OWNER_LABEL] = json!("PRIVATE_SENTINEL");
            } else {
                value[field] = json!("PRIVATE_SENTINEL");
            }
            cases.push((200, value, ObservationError::BindingMismatch));
        }
        for field in ["Running", "Status"] {
            let mut value = baseline.clone();
            value["State"].as_object_mut().unwrap().remove(field);
            cases.push((200, value, ObservationError::Incomplete));
        }
        for (status, error) in [
            (401, ObservationError::Authentication),
            (403, ObservationError::Permission),
            (503, ObservationError::Transport),
        ] {
            cases.push((status, json!({"message":"PRIVATE_SENTINEL"}), error));
        }
        for (status, value, expected) in cases {
            let (_fixture, gateway) = observer(move || (status, value.clone())).await;
            let error = gateway
                .observe(Duration::from_secs(2), || std::future::ready(Ok("ready")))
                .await
                .unwrap_err();
            assert_eq!(error, Failure::Observation(expected));
            assert!(!error.message(gateway.name()).contains("PRIVATE_SENTINEL"));
        }
        let (_fixture, gateway) = observer(|| (404, json!({"message":"PRIVATE_SENTINEL"}))).await;
        assert_eq!(
            gateway
                .observe::<(), _>(Duration::from_secs(2), std::future::pending)
                .await
                .unwrap_err(),
            Failure::Stopped {
                status: "absent",
                exit_code: None
            }
        );
    }
}
