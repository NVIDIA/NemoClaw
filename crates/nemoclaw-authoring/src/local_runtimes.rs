// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The runtimes a journey can run sandboxes on, found on this machine's default
//! sockets: which engine each needs, the query that asks whether it is
//! available, and which of them the observations show to be reachable.
use nemoclaw_discovery::DiscoveryObservations;
use nemoclaw_sdk::{
    config::ComputeDriver,
    discovery::{DiscoveryQuery, DiscoveryRequest, ObservationStatus},
};

/// The local engine socket for each runtime a journey can offer.
const LOCAL_ENGINES: [(&str, ComputeDriver, &str); 2] = [
    (
        "docker",
        ComputeDriver::Docker,
        "unix:///var/run/docker.sock",
    ),
    (
        "podman",
        ComputeDriver::Podman,
        "unix:///run/user/1000/podman/podman.sock",
    ),
];

/// The managed gateway engine that matches a runtime answer.
pub(crate) fn local_engine(runtime: &str) -> Option<&'static str> {
    LOCAL_ENGINES
        .iter()
        .find(|(name, ..)| *name == runtime)
        .map(|(.., engine)| *engine)
}

/// Queries that need no answers: which local engines can run sandboxes. They
/// are asked once, before the first question, so early choices can use them.
pub fn environment_queries() -> Vec<DiscoveryQuery> {
    LOCAL_ENGINES
        .iter()
        .map(|(_, compute_driver, engine)| {
            DiscoveryQuery::Engine(DiscoveryRequest {
                engine: (*engine).into(),
                compute_driver: *compute_driver,
            })
        })
        .collect()
}

/// The runtimes whose local engine the observations show as available.
pub(crate) fn reachable_runtimes(observations: &DiscoveryObservations) -> Vec<&'static str> {
    LOCAL_ENGINES
        .iter()
        .filter(|(_, compute_driver, engine)| {
            observations
                .engine(&DiscoveryRequest {
                    engine: (*engine).into(),
                    compute_driver: *compute_driver,
                })
                .is_some_and(|engine| engine.status == ObservationStatus::Available)
        })
        .map(|(name, ..)| *name)
        .collect()
}
