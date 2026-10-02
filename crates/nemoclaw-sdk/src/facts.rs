// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! One sheet for everything learned about the target environment.
//!
//! A [`FactQuery`] names a read by its inputs and a [`FactSheet`] holds what
//! each read returned, so a fact can never be mistaken for one about a
//! different engine, image, or endpoint. A [`FactSource`] answers queries:
//! the provider-backed [`DiscoverySession`] reads the real target, and
//! [`FixtureFacts`] replays a recorded sheet, which lets callers test their
//! decisions against any hardware without owning it.
use crate::{
    CancellationToken, EnvironmentSecrets, Error,
    config::{ComputeDriver, Gateway},
    discovery::{
        DiscoveryObservation, DiscoveryRequest, EngineObservation, FabricObservation,
        GatewayObservation,
    },
    discovery_session::{DiscoveryQuery, DiscoverySession},
    hardware_discovery::HardwareObservation,
    inference_discovery::{
        CredentialObservation, EndpointObservation, EndpointRequest, observe_credential,
    },
};
use serde::{Deserialize, Serialize};
use std::future::Future;

/// Rounds of observation after which [`gather`] concludes the needs never settle.
const MAX_ROUNDS: usize = 8;

/// A read of the environment, identified by everything that determines its answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FactQuery {
    Engine(DiscoveryRequest),
    Hardware {
        engine: String,
    },
    Fabric {
        engine: String,
        image: String,
    },
    Endpoint(EndpointRequest),
    Gateway {
        gateway: Gateway,
        compute_drivers: Vec<ComputeDriver>,
    },
    /// Whether a credential reference resolves locally; never its value.
    Credential {
        reference: String,
    },
}

/// What one [`FactQuery`] observed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fact {
    Engine(EngineObservation),
    Hardware(HardwareObservation),
    Fabric(FabricObservation),
    Endpoint(EndpointObservation),
    Gateway(GatewayObservation),
    Credential(CredentialObservation),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    query: FactQuery,
    /// `None` records an attempt that produced no observation, so callers do
    /// not ask again. It is not the same as an observation of status `Unknown`.
    fact: Option<Fact>,
}

/// Facts keyed by their queries. A query absent from the sheet was never asked.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FactSheet {
    entries: Vec<Entry>,
}

impl FactSheet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, query: FactQuery, fact: Option<Fact>) -> Self {
        self.record(query, fact);
        self
    }

    /// Record an attempt; a later record of the same query replaces the earlier one.
    pub fn record(&mut self, query: FactQuery, fact: Option<Fact>) {
        match self.entries.iter_mut().find(|entry| entry.query == query) {
            Some(entry) => entry.fact = fact,
            None => self.entries.push(Entry { query, fact }),
        }
    }

    pub fn merge(&mut self, other: FactSheet) {
        for entry in other.entries {
            self.record(entry.query, entry.fact);
        }
    }

    pub fn attempted(&self, query: &FactQuery) -> bool {
        self.entries.iter().any(|entry| &entry.query == query)
    }

    pub fn fact(&self, query: &FactQuery) -> Option<&Fact> {
        self.entries
            .iter()
            .find(|entry| &entry.query == query)
            .and_then(|entry| entry.fact.as_ref())
    }

    /// The distinct queries not yet attempted, in the order given.
    pub fn missing(&self, needs: &[FactQuery]) -> Vec<FactQuery> {
        let mut missing: Vec<FactQuery> = Vec::new();
        for query in needs {
            if !self.attempted(query) && !missing.contains(query) {
                missing.push(query.clone());
            }
        }
        missing
    }

    pub fn engine(&self, request: &DiscoveryRequest) -> Option<&EngineObservation> {
        match self.fact(&FactQuery::Engine(request.clone())) {
            Some(Fact::Engine(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn hardware(&self, engine: &str) -> Option<&HardwareObservation> {
        match self.fact(&FactQuery::Hardware {
            engine: engine.into(),
        }) {
            Some(Fact::Hardware(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn fabric(&self, engine: &str, image: &str) -> Option<&FabricObservation> {
        match self.fact(&FactQuery::Fabric {
            engine: engine.into(),
            image: image.into(),
        }) {
            Some(Fact::Fabric(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn endpoint(&self, request: &EndpointRequest) -> Option<&EndpointObservation> {
        match self.fact(&FactQuery::Endpoint(request.clone())) {
            Some(Fact::Endpoint(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn gateway(
        &self,
        gateway: &Gateway,
        compute_drivers: &[ComputeDriver],
    ) -> Option<&GatewayObservation> {
        match self.fact(&FactQuery::Gateway {
            gateway: gateway.clone(),
            compute_drivers: compute_drivers.to_vec(),
        }) {
            Some(Fact::Gateway(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn credential(&self, reference: &str) -> Option<&CredentialObservation> {
        match self.fact(&FactQuery::Credential {
            reference: reference.into(),
        }) {
            Some(Fact::Credential(observation)) => Some(observation),
            _ => None,
        }
    }
}

/// Answers queries. The result has an entry for every distinct query asked,
/// with no fact for a read that could not be made. An error means the whole
/// round was abandoned, which is only cancellation.
pub trait FactSource {
    fn observe(
        &mut self,
        queries: &[FactQuery],
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<FactSheet, Error>>;
}

/// Replays a recorded sheet. Anything it does not hold is recorded as unobserved.
pub struct FixtureFacts(FactSheet);

impl FixtureFacts {
    pub fn new(sheet: FactSheet) -> Self {
        Self(sheet)
    }
}

impl FactSource for FixtureFacts {
    async fn observe(
        &mut self,
        queries: &[FactQuery],
        _cancel: &CancellationToken,
    ) -> Result<FactSheet, Error> {
        let mut observed = FactSheet::new();
        for query in queries {
            observed.record(query.clone(), self.0.fact(query).cloned());
        }
        Ok(observed)
    }
}

/// Observe whatever `needs` asks for until nothing it asks for is missing.
/// `needs` sees the sheet so that a read can depend on an earlier one.
pub async fn gather<S: FactSource>(
    source: &mut S,
    sheet: &mut FactSheet,
    mut needs: impl FnMut(&FactSheet) -> Vec<FactQuery>,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    for _ in 0..MAX_ROUNDS {
        let missing = sheet.missing(&needs(sheet));
        if missing.is_empty() {
            return Ok(());
        }
        sheet.merge(source.observe(&missing, cancel).await?);
    }
    Err(Error::State("fact gathering did not settle"))
}

impl FactSource for DiscoverySession {
    /// One provider plan serves every provider read; the gateway read and the
    /// local credential check are separate. A failed read leaves no fact, and
    /// only cancellation abandons the round.
    async fn observe(
        &mut self,
        queries: &[FactQuery],
        cancel: &CancellationToken,
    ) -> Result<FactSheet, Error> {
        let mut distinct: Vec<&FactQuery> = Vec::new();
        for query in queries {
            if !distinct.contains(&query) {
                distinct.push(query);
            }
        }
        let mut observed = FactSheet::new();
        let provider: Vec<(&FactQuery, DiscoveryQuery)> = distinct
            .iter()
            .filter_map(|query| Some((*query, provider_query(query)?)))
            .collect();
        let batch: Vec<DiscoveryQuery> = provider.iter().map(|(_, query)| query.clone()).collect();
        match self.batch(&batch, cancel).await {
            Ok(observations) => {
                for ((query, _), observation) in provider.iter().zip(observations) {
                    observed.record((*query).clone(), fact_for(query, observation));
                }
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(_) => {
                for (query, _) in &provider {
                    observed.record((*query).clone(), None);
                }
            }
        }
        for query in distinct {
            match query {
                FactQuery::Gateway {
                    gateway,
                    compute_drivers,
                } => {
                    let fact = match self.gateway(gateway, compute_drivers, cancel).await {
                        Ok(observation) => Some(Fact::Gateway(observation)),
                        Err(Error::Cancelled) => return Err(Error::Cancelled),
                        Err(_) => None,
                    };
                    observed.record(query.clone(), fact);
                }
                FactQuery::Credential { reference } => observed.record(
                    query.clone(),
                    Some(Fact::Credential(observe_credential(
                        &EnvironmentSecrets,
                        reference,
                    ))),
                ),
                _ => {}
            }
        }
        Ok(observed)
    }
}

fn provider_query(query: &FactQuery) -> Option<DiscoveryQuery> {
    Some(match query {
        FactQuery::Engine(request) => DiscoveryQuery::Engine(request.clone()),
        FactQuery::Hardware { engine } => DiscoveryQuery::Hardware {
            engine: engine.clone(),
        },
        FactQuery::Fabric { engine, image } => DiscoveryQuery::Fabric {
            engine: engine.clone(),
            image: image.clone(),
        },
        FactQuery::Endpoint(request) => DiscoveryQuery::Inference(request.clone()),
        FactQuery::Gateway { .. } | FactQuery::Credential { .. } => return None,
    })
}

fn fact_for(query: &FactQuery, observation: DiscoveryObservation) -> Option<Fact> {
    match (query, observation) {
        (FactQuery::Engine(_), DiscoveryObservation::Engine(observed)) => {
            Some(Fact::Engine(observed))
        }
        (FactQuery::Hardware { .. }, DiscoveryObservation::Hardware(observed)) => {
            Some(Fact::Hardware(observed))
        }
        (FactQuery::Fabric { .. }, DiscoveryObservation::Fabric(observed)) => {
            Some(Fact::Fabric(observed))
        }
        (FactQuery::Endpoint(_), DiscoveryObservation::Inference(observed)) => {
            Some(Fact::Endpoint(observed))
        }
        _ => None,
    }
}
