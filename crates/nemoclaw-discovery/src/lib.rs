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
mod ssh;

pub use engine::{Direct, Engine, Engines, is_missing, optional, remote};
pub use facts::{judge_image, observe_engine, observe_fabric, observe_hardware};
pub use inference::observe_endpoint;
pub use local::local_engine_candidates;
#[cfg(unix)]
pub use ssh::command as ssh_command;

use futures_util::future::join_all;
use nemoclaw_sdk::{
    CancellationToken, Error, Secrets,
    discovery::{DiscoveryObservation, DiscoveryQuery, DiscoveryRequest, EngineObservation},
    inference_discovery::{
        CredentialObservation, EndpointObservation, EndpointRequest, observe_credential,
    },
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    query: DiscoveryQuery,
    observation: DiscoveryObservation,
}

/// Observations keyed by the query that produced them. A query absent from the
/// collection was never asked; one that failed holds an unknown observation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DiscoveryObservations {
    entries: Vec<Entry>,
}

impl DiscoveryObservations {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, query: DiscoveryQuery, observation: DiscoveryObservation) -> Self {
        self.record(query, observation);
        self
    }

    /// Record an observation; a later record of the same query replaces the earlier one.
    pub fn record(&mut self, query: DiscoveryQuery, observation: DiscoveryObservation) {
        match self.entries.iter_mut().find(|entry| entry.query == query) {
            Some(entry) => entry.observation = observation,
            None => self.entries.push(Entry { query, observation }),
        }
    }

    pub fn merge(&mut self, other: DiscoveryObservations) {
        for entry in other.entries {
            self.record(entry.query, entry.observation);
        }
    }

    /// Whether nothing has been asked yet.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, query: &DiscoveryQuery) -> bool {
        self.get(query).is_some()
    }

    pub fn get(&self, query: &DiscoveryQuery) -> Option<&DiscoveryObservation> {
        self.entries
            .iter()
            .find(|entry| &entry.query == query)
            .map(|entry| &entry.observation)
    }

    /// The distinct queries not yet asked, in the order given.
    pub fn missing(&self, queries: &[DiscoveryQuery]) -> Vec<DiscoveryQuery> {
        let mut missing: Vec<DiscoveryQuery> = Vec::new();
        for query in queries {
            if !self.contains(query) && !missing.contains(query) {
                missing.push(query.clone());
            }
        }
        missing
    }

    pub fn engine(&self, request: &DiscoveryRequest) -> Option<&EngineObservation> {
        match self.get(&DiscoveryQuery::Engine(request.clone())) {
            Some(DiscoveryObservation::Engine(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn inference(&self, request: &EndpointRequest) -> Option<&EndpointObservation> {
        match self.get(&DiscoveryQuery::Inference(request.clone())) {
            Some(DiscoveryObservation::Inference(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn credential(&self, reference: &str) -> Option<&CredentialObservation> {
        match self.get(&DiscoveryQuery::Credential {
            reference: reference.into(),
        }) {
            Some(DiscoveryObservation::Credential(observation)) => Some(observation),
            _ => None,
        }
    }
}

/// Answer each distinct query, reading independent facts concurrently. A read
/// that fails is an unknown observation, never absence, so the only error is
/// cancellation. An image read on a platform takes it from its engine's answer.
pub async fn observe(
    queries: &[DiscoveryQuery],
    engines: &dyn Engines,
    secrets: &dyn Secrets,
    cancel: &CancellationToken,
) -> Result<DiscoveryObservations, Error> {
    let mut distinct: Vec<&DiscoveryQuery> = Vec::new();
    for query in queries {
        if !distinct.contains(&query) {
            distinct.push(query);
        }
    }
    let work = async {
        let platforms: Vec<DiscoveryRequest> = distinct
            .iter()
            .filter_map(|query| match query {
                DiscoveryQuery::Fabric {
                    platform: Some(request),
                    ..
                } => Some(request.clone()),
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
                DiscoveryQuery::Hardware { engine } => {
                    DiscoveryObservation::Hardware(observe_hardware(engines, engine).await)
                }
                DiscoveryQuery::Fabric {
                    engine,
                    image,
                    requirements,
                    platform: requested,
                    metadata_env,
                } => {
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
                DiscoveryQuery::Gateway {
                    gateway,
                    compute_drivers,
                } => DiscoveryObservation::Gateway(
                    gateway::observe_gateway(gateway, compute_drivers, secrets).await,
                ),
                DiscoveryQuery::Credential { reference } => {
                    DiscoveryObservation::Credential(observe_credential(secrets, reference))
                }
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
