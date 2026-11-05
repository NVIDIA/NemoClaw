// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Engine prerequisite checks for an OpenShell gateway.
use bollard::models::SystemInfo;
pub use nemoclaw_docker::{Direct, Engine, Engines, is_missing, optional, remote};
use nemoclaw_sdk::{Error, config::ComputeDriver};

/// Read the engine and check existing gateway prerequisites without changing resources.
/// Passing this check does not establish image, GPU, or deployment readiness.
pub async fn gateway_engine_info(
    engine: &Engine,
    driver: ComputeDriver,
) -> Result<SystemInfo, Error> {
    if driver == ComputeDriver::Podman {
        #[cfg(unix)]
        {
            let native = engine.podman_json("info").await?;
            let rootless = native["host"]["security"]["rootless"]
                .as_bool()
                .ok_or(nemoclaw_sdk::ObservationError::Incomplete)?;
            if rootless && native["host"]["rootlessNetworkCmd"] != serde_json::json!("pasta") {
                return Err(Error::Conflict(
                    "managed rootless Podman requires an API that reports pasta networking for OpenShell callbacks",
                ));
            }
        }
        let version = engine.api.version().await.map_err(|error| remote(&error))?;
        if !version
            .components
            .unwrap_or_default()
            .iter()
            .any(|part| part.name == "Podman Engine")
        {
            return Err(Error::Conflict(
                "Podman sandbox driver requires a Podman engine socket",
            ));
        }
    }
    engine.info().await
}

/// Why a gateway can't take its endpoint's port. The first successful plan
/// binds the endpoint in state, so only a deployment before then can change it.
pub const GATEWAY_PORT_TAKEN: &str = "the gateway endpoint's port is in use by another container or process; free the port, or, before this deployment's first successful plan, set spec.gateway.endpoint to a free port";

/// Check that only the deployment's own gateway, `name` labeled with `owner`,
/// holds the endpoint's port: no other running container publishes it, and,
/// for local Podman, whose gateway listens on the host's loopback, nothing
/// else listens on it. A host process holding a Docker engine's port is left
/// to Docker's error when the gateway starts; that host may be remote.
pub async fn check_gateway_port(
    engine: &Engine,
    driver: ComputeDriver,
    endpoint: &str,
    name: &str,
    owner: &str,
) -> Result<(), Error> {
    use bollard::models::PortSummaryTypeEnum;
    let port = endpoint
        .strip_prefix("http://")
        .map(|authority| authority.trim_end_matches('/'))
        .and_then(|authority| authority.rsplit_once(':'))
        .and_then(|(_, port)| port.parse::<u16>().ok())
        .ok_or(Error::Conflict("invalid gateway endpoint"))?;
    let containers = engine
        .api
        .list_containers(None)
        .await
        .map_err(|error| remote(&error))?;
    let mut own_running = false;
    for container in containers {
        let own = container
            .names
            .iter()
            .flatten()
            .any(|candidate| candidate.strip_prefix('/') == Some(name))
            && container
                .labels
                .as_ref()
                .and_then(|labels| labels.get(nemoclaw_docker::OWNER_LABEL))
                .is_some_and(|label| label == owner);
        if own {
            own_running = true;
            continue;
        }
        // The gateway takes 127.0.0.1. Docker binds an IPv6 host port on its
        // own, so a publish on `::` alone leaves the IPv4 port free.
        let publishes = container.ports.iter().flatten().any(|published| {
            published.public_port == Some(port)
                && published.typ == Some(PortSummaryTypeEnum::TCP)
                && matches!(
                    published.ip.as_deref(),
                    None | Some("" | "0.0.0.0" | "127.0.0.1")
                )
        });
        if publishes {
            return Err(Error::Conflict(GATEWAY_PORT_TAKEN));
        }
    }
    if driver == ComputeDriver::Podman && !own_running {
        match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                return Err(Error::Conflict(GATEWAY_PORT_TAKEN));
            }
            Err(_) => return Err(Error::State("gateway port bind probe failed")),
        }
    }
    Ok(())
}
