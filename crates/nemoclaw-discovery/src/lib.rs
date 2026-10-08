// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Read-only facts about a deployment target.
//!
//! The provider's data sources and onboarding read the target through the same
//! functions: a plan through OpenTofu, because apply reads again and resources
//! consume the results, and onboarding directly, with [`observe`].
mod engine;
mod facts;
pub mod gateway;
mod inference;
mod local;

pub use engine::{Direct, Engine, Engines, gateway_engine_info, is_missing, optional, remote};
pub use facts::{observe_engine, observe_hardware};
pub use inference::observe_endpoint;
pub use local::local_engine_candidates;
#[cfg(unix)]
pub use nemoclaw_docker::ssh_command;
pub use nemoclaw_fabric::{judge_image, observe_fabric};

use futures_util::future::join_all;
use nemoclaw_sdk::{
    CancellationToken, Error, Secrets,
    discovery::{
        DiscoveryObservation, DiscoveryObservations, DiscoveryQuery, DiscoveryRequest,
        FabricRequest, GatewayRequest, distinct,
    },
    inference_discovery::observe_credential,
};

/// Answer each distinct query, reading independent facts concurrently. A read
/// that fails is an unknown observation, never absence, so the only error is
/// cancellation. An image read on a platform takes it from its engine's answer.
pub async fn observe(
    queries: &[DiscoveryQuery],
    engines: &dyn Engines,
    secrets: &dyn Secrets,
    cancel: &CancellationToken,
) -> Result<DiscoveryObservations, Error> {
    let distinct = distinct(queries);
    let work = async {
        let platforms: Vec<DiscoveryRequest> = distinct
            .iter()
            .filter_map(|query| match query {
                DiscoveryQuery::Fabric(FabricRequest {
                    platform: Some(request),
                    ..
                }) => Some(request.clone()),
                _ => None,
            })
            .collect();
        let engines_read = join_all(
            platforms
                .iter()
                .map(|request| async move { (request, observe_engine(engines, request).await) }),
        )
        .await;
        let platform = |request: &Option<DiscoveryRequest>| {
            request.as_ref().and_then(|request| {
                engines_read
                    .iter()
                    .find(|(read, _)| *read == request)
                    .map(|(_, observed)| observed)
            })
        };
        let answers = join_all(distinct.iter().map(|query| async {
            let observation = match query {
                DiscoveryQuery::Engine(request) => match platform(&Some(request.clone())) {
                    Some(observed) => DiscoveryObservation::Engine(observed.clone()),
                    None => DiscoveryObservation::Engine(observe_engine(engines, request).await),
                },
                DiscoveryQuery::Hardware(request) => {
                    DiscoveryObservation::Hardware(observe_hardware(engines, &request.engine).await)
                }
                DiscoveryQuery::Fabric(FabricRequest {
                    engine,
                    image,
                    requirements,
                    platform: requested,
                    metadata_env,
                }) => {
                    // A cluster image is read from its metadata bundle, not an engine.
                    let mut observed = match metadata_env {
                        Some(name) => nemoclaw_sdk::image_metadata::observe(secrets, name, image),
                        None => observe_fabric(engines, engine, image).await,
                    };
                    let platform = platform(requested);
                    judge_image(
                        &mut observed,
                        image,
                        requirements,
                        platform.and_then(|engine| engine.architecture.as_deref()),
                        platform.and_then(|engine| engine.operating_system.as_deref()),
                    );
                    DiscoveryObservation::Fabric(observed)
                }
                DiscoveryQuery::Inference(request) => {
                    DiscoveryObservation::Inference(observe_endpoint(request, secrets).await)
                }
                DiscoveryQuery::Gateway(GatewayRequest {
                    gateway,
                    compute_drivers,
                }) => DiscoveryObservation::Gateway(
                    gateway::observe_gateway(gateway, compute_drivers, secrets).await,
                ),
                DiscoveryQuery::Credential(request) => DiscoveryObservation::Credential(
                    observe_credential(secrets, &request.reference),
                ),
            };
            ((*query).clone(), observation)
        }))
        .await;
        let mut observed = DiscoveryObservations::new();
        for (query, observation) in answers {
            observed.record(query, observation);
        }
        observed
    };
    tokio::select! {
        () = cancel.cancelled() => Err(Error::Cancelled),
        observed = work => Ok(observed),
    }
}
