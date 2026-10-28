// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Whether an engine meets a managed gateway's prerequisites for a compute
//! driver. `host_engine` reads the engine's facts.

use crate::provider::ConfiguredBackend;
use async_trait::async_trait;
use nemoclaw_discovery::{
    Engines, GATEWAY_PORT_TAKEN, check_gateway_port, observe_gateway_prerequisites,
};
use nemoclaw_sdk::discovery::{DiscoveryRequest, ObservationStatus};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tf_provider::{
    DataSource, Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// Data source for whether an engine can host a managed gateway with a
/// compute driver. The gateway installation types enforce the same check.
pub(crate) struct GatewayPrerequisitesDataSource(pub Arc<ConfiguredBackend>);

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct GatewayPrerequisitesState {
    engine: Value<String>,
    compute_driver: Value<String>,
    #[serde(default)]
    endpoint: Value<String>,
    #[serde(default)]
    name: Value<String>,
    #[serde(default)]
    owner: Value<String>,
    observation_json: Value<String>,
    available: Value<bool>,
    status: Value<String>,
}

fn engine_valid(engine: &Value<String>) -> bool {
    match engine {
        Value::Unknown => true,
        Value::Value(engine) => crate::config::validate_engine_endpoint(engine).is_ok(),
        Value::Null => false,
    }
}

fn driver_valid(driver: &Value<String>) -> bool {
    match driver {
        Value::Unknown => true,
        Value::Value(driver) => driver == "docker" || driver == "podman",
        Value::Null => false,
    }
}

/// Required string `inputs`, the gateway's optional endpoint and identity for
/// its port check, then the observation every engine read reports.
fn schema(inputs: &[&str]) -> Schema {
    use AttributeConstraint::{Computed, Optional, Required};
    use AttributeType::{Bool, String};
    Schema {
        version: 0,
        block: Block {
            attributes: inputs
                .iter()
                .map(|name| (*name, String, Required))
                .chain([
                    ("endpoint", String, Optional),
                    ("name", String, Optional),
                    ("owner", String, Optional),
                ])
                .chain([
                    ("observation_json", String, Computed),
                    ("available", Bool, Computed),
                    ("status", String, Computed),
                ])
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
    }
}

/// The observation's outputs: its JSON, whether it is available, and its status.
type Outputs = (Value<String>, Value<bool>, Value<String>);

fn outputs<T: Serialize>(
    diags: &mut Diagnostics,
    observation: &T,
    status: ObservationStatus,
) -> Option<Outputs> {
    let Ok(json) = serde_json::to_string(observation) else {
        diags.root_error_short("Discovery observation could not be encoded");
        return None;
    };
    let name = match status {
        ObservationStatus::Available => "available",
        ObservationStatus::Unavailable => "unavailable",
        ObservationStatus::Unknown => "unknown",
    };
    Some((
        Value::Value(json),
        Value::Value(status == ObservationStatus::Available),
        Value::Value(name.into()),
    ))
}

fn invalid(diags: &mut Diagnostics) {
    diags.root_error_short("Invalid discovery target or selection");
}

#[async_trait]
impl DataSource for GatewayPrerequisitesDataSource {
    type State<'a> = GatewayPrerequisitesState;
    type ProviderMetaState<'a> = ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(schema(&["engine", "compute_driver"]))
    }

    async fn validate<'a>(
        &self,
        diags: &mut Diagnostics,
        config: GatewayPrerequisitesState,
    ) -> Option<()> {
        if engine_valid(&config.engine) && driver_valid(&config.compute_driver) {
            Some(())
        } else {
            invalid(diags);
            None
        }
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        mut config: GatewayPrerequisitesState,
        _: ValueEmpty,
    ) -> Option<GatewayPrerequisitesState> {
        if !engine_valid(&config.engine) || !driver_valid(&config.compute_driver) {
            invalid(diags);
            return None;
        }
        let (Value::Value(engine), Value::Value(driver)) = (&config.engine, &config.compute_driver)
        else {
            config.observation_json = Value::Unknown;
            config.available = Value::Unknown;
            config.status = Value::Unknown;
            return Some(config);
        };
        let compute_driver = driver.parse().ok()?;
        let mut observation = observe_gateway_prerequisites(
            self.0.connections(),
            &DiscoveryRequest {
                engine: engine.clone(),
                compute_driver,
            },
        )
        .await;
        // Apply binds the deployment before the gateway takes its port, so a
        // port held by anything else must fail plan.
        if observation.status == ObservationStatus::Available
            && let (Value::Value(endpoint), Value::Value(name), Value::Value(owner)) =
                (&config.endpoint, &config.name, &config.owner)
        {
            let work = async {
                let engine = self.0.connections().engine(engine)?;
                check_gateway_port(&engine, compute_driver, endpoint, name, owner).await
            };
            let (status, reason) =
                match tokio::time::timeout(std::time::Duration::from_secs(5), work).await {
                    Ok(Ok(())) => (ObservationStatus::Available, None),
                    Ok(Err(nemoclaw_sdk::Error::Conflict(GATEWAY_PORT_TAKEN))) => (
                        ObservationStatus::Unavailable,
                        Some(GATEWAY_PORT_TAKEN.into()),
                    ),
                    Ok(Err(error)) => (ObservationStatus::Unknown, Some(error.to_string())),
                    Err(_) => (
                        ObservationStatus::Unknown,
                        Some("gateway port observation timed out".into()),
                    ),
                };
            observation.status = status;
            observation.reason = reason;
        }
        (config.observation_json, config.available, config.status) =
            outputs(diags, &observation, observation.status)?;
        Some(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNREACHABLE: &str = "unix:///does-not-exist/nemoclaw.sock";

    fn prerequisites_config(driver: &str) -> GatewayPrerequisitesState {
        GatewayPrerequisitesState {
            engine: Value::Value(UNREACHABLE.into()),
            compute_driver: Value::Value(driver.into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn another_container_on_the_endpoint_port_makes_the_engine_unavailable() {
        use crate::docker::{Connections, fixture::Fixture};
        use serde_json::json;
        const ENGINE: &str = "unix:///var/run/docker.sock";
        const OWN: (&str, &str) = ("nc-0123456789abcdef-gateway", "own-uid");
        let published = |name: &str, owner: &str, ip: &str, port: u16, kind: &str| {
            json!([{
                "Id": name, "Names": [format!("/{name}")],
                "Labels": {crate::managed::OWNER_LABEL: owner},
                "Ports": [{"IP": ip, "PrivatePort": 17670, "PublicPort": port, "Type": kind}],
            }])
        };
        let taken = published("other-gateway", "other-uid", "127.0.0.1", 17695, "tcp");
        for (containers, with_endpoint, expected) in [
            (taken.clone(), true, "unavailable"),
            (
                published("other", "", "0.0.0.0", 17695, "tcp"),
                true,
                "unavailable",
            ),
            (
                published("other", "", "127.0.0.1", 17696, "tcp"),
                true,
                "available",
            ),
            (
                published("other", "", "127.0.0.1", 17695, "udp"),
                true,
                "available",
            ),
            // Docker binds an IPv6 host port alone, leaving 127.0.0.1 free.
            (
                published("other", "", "::", 17695, "tcp"),
                true,
                "available",
            ),
            (
                published(OWN.0, OWN.1, "127.0.0.1", 17695, "tcp"),
                true,
                "available",
            ),
            (taken, false, "available"),
        ] {
            let fixture = Fixture::engine(move |request| {
                let body = match request.path.split('?').next().unwrap() {
                    "/info" => json!({"ID": "selected-engine"}),
                    "/containers/json" => containers.clone(),
                    path => panic!("unexpected observation {path}"),
                };
                Some((200, serde_json::to_vec(&body).unwrap()))
            })
            .await;
            let backend =
                ConfiguredBackend::fixed(Connections::fixed([fixture.engine_for(ENGINE)]).unwrap());
            let mut config = GatewayPrerequisitesState {
                engine: Value::Value(ENGINE.into()),
                compute_driver: Value::Value("docker".into()),
                ..Default::default()
            };
            if with_endpoint {
                config.endpoint = Value::Value("http://127.0.0.1:17695".into());
                config.name = Value::Value(OWN.0.into());
                config.owner = Value::Value(OWN.1.into());
            }
            let mut diagnostics = Diagnostics::default();
            let observed = GatewayPrerequisitesDataSource(Arc::new(backend))
                .read(&mut diagnostics, config, ValueEmpty::default())
                .await
                .unwrap();
            assert!(diagnostics.errors.is_empty(), "{diagnostics:?}");
            let Value::Value(json) = &observed.observation_json else {
                panic!("completed observation")
            };
            let observation: serde_json::Value = serde_json::from_str(json).unwrap();
            assert_eq!(observation["status"], expected, "{observation}");
            if expected == "unavailable" {
                assert_eq!(
                    observation["reason"],
                    "the gateway endpoint's port is in use by another container or process; free the port, or, before this deployment's first successful plan, set spec.gateway.endpoint to a free port"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_process_on_the_port_takes_it_from_a_local_podman_gateway() {
        use crate::docker::fixture::Fixture;
        use nemoclaw_sdk::config::ComputeDriver::{Docker, Podman};
        use serde_json::json;
        const OWN: (&str, &str) = ("nc-0123456789abcdef-gateway", "own-uid");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        for (own_running, driver, taken) in [
            (false, Podman, true),
            (true, Podman, false),
            (false, Docker, false),
        ] {
            let containers = if own_running {
                json!([{"Id": "own", "Names": [format!("/{}", OWN.0)],
                    "Labels": {crate::managed::OWNER_LABEL: OWN.1}, "Ports": []}])
            } else {
                json!([])
            };
            let fixture =
                Fixture::engine(move |_| Some((200, serde_json::to_vec(&containers).unwrap())))
                    .await;
            let result = check_gateway_port(
                &fixture.engine_for("unix:///run/user/1000/podman/podman.sock"),
                driver,
                &endpoint,
                OWN.0,
                OWN.1,
            )
            .await;
            assert_eq!(
                result.err().map(|error| error.to_string()).as_deref(),
                taken.then_some(GATEWAY_PORT_TAKEN),
                "{driver:?}, own gateway running: {own_running}"
            );
        }
        drop(listener);
    }

    fn status(json: &Value<String>) -> serde_json::Value {
        let Value::Value(json) = json else {
            panic!("completed observation")
        };
        serde_json::from_str::<serde_json::Value>(json).unwrap()["status"].clone()
    }

    #[tokio::test]
    async fn unavailable_transport_returns_completed_unknown_observation_without_provider_error() {
        let mut diagnostics = Diagnostics::default();
        let prerequisites = GatewayPrerequisitesDataSource(Arc::new(ConfiguredBackend::default()))
            .read(
                &mut diagnostics,
                prerequisites_config("podman"),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(matches!(prerequisites.available, Value::Value(false)));
        assert_eq!(status(&prerequisites.observation_json), "unknown");
        assert!(diagnostics.errors.is_empty());
    }

    #[tokio::test]
    async fn unknown_inputs_validate_without_connecting_and_invalid_values_do_not_leak() {
        let prerequisites = GatewayPrerequisitesDataSource(Arc::new(ConfiguredBackend::default()));
        let mut diagnostics = Diagnostics::default();
        let mut unknown = prerequisites_config("docker");
        unknown.engine = Value::Unknown;
        unknown.compute_driver = Value::Unknown;
        assert!(
            prerequisites
                .validate(&mut diagnostics, unknown)
                .await
                .is_some()
        );
        let invalid = prerequisites_config("PRIVATE_SENTINEL");
        assert!(
            prerequisites
                .validate(&mut diagnostics, invalid)
                .await
                .is_none()
        );
        assert!(!format!("{diagnostics:?}").contains("PRIVATE_SENTINEL"));
    }
}
