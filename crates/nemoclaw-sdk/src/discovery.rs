// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! What a deployment needs to know about its target, and what each read reports.
pub use crate::gateway_observation::{GatewayCapabilities, GatewayObservation};
use crate::{
    config::{ComputeDriver, ConfigError, Document, Gateway},
    fabric_capabilities::FabricRequirements,
    fabric_catalog::FabricCatalog,
    hardware_discovery::HardwareObservation,
    inference_discovery::{CredentialObservation, EndpointObservation, EndpointRequest},
};
use serde::{Deserialize, Serialize};

/// A read of the target, identified by everything that determines its answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiscoveryQuery {
    Engine(DiscoveryRequest),
    Hardware(HardwareRequest),
    /// An image read, judged against what its sandbox requires.
    Fabric(FabricRequest),
    Inference(EndpointRequest),
    Gateway(GatewayRequest),
    /// Whether a credential reference resolves locally; never its value.
    Credential(CredentialRequest),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareRequest {
    pub engine: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricRequest {
    pub engine: String,
    pub image: String,
    pub requirements: FabricRequirements,
    /// The engine whose platform the image must run on: a managed
    /// gateway's. An external gateway's image store does not establish it.
    pub platform: Option<DiscoveryRequest>,
    /// On Kubernetes and OpenShift, where no engine can inspect the image,
    /// the environment variable naming its metadata bundle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_env: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayRequest {
    pub gateway: Gateway,
    pub compute_drivers: Vec<ComputeDriver>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialRequest {
    pub reference: String,
}

/// The reads a plan makes of the target for `document`, in the order it names
/// them: the gateway, each external inference endpoint, the hardware of every
/// engine that services or a managed gateway use, a managed gateway's engine,
/// and one image read per sandbox. The image reads are per sandbox, sorted by
/// sandbox name, because each carries that sandbox's own requirements, and a
/// managed gateway's image reads run on its engine's platform.
pub fn plan_queries(document: &Document) -> Result<Vec<DiscoveryQuery>, ConfigError> {
    let mut queries = vec![DiscoveryQuery::Gateway(GatewayRequest {
        gateway: document.spec.gateway.clone(),
        compute_drivers: vec![document.spec.gateway.runtime().provider],
    })];
    queries.extend(
        crate::inference_discovery::endpoint_requests(document)
            .map_err(|_| ConfigError::new("inference discovery inputs are invalid"))?
            .into_iter()
            .map(DiscoveryQuery::Inference),
    );
    let mut engines = crate::services::discovery_engines(document)?;
    if let Some(gateway) = document.spec.gateway.as_local_managed() {
        engines.insert(gateway.engine.clone());
    }
    queries.extend(
        engines
            .into_iter()
            .map(|engine| DiscoveryQuery::Hardware(HardwareRequest { engine })),
    );
    // A cluster has no engine to read images from; their metadata bundles
    // answer instead.
    let kubernetes = document.spec.gateway.runtime().provider.is_kubernetes();
    let engine = match &document.spec.gateway {
        _ if kubernetes => "",
        Gateway::Managed(gateway) => &gateway.engine,
        Gateway::External(gateway) => &gateway.engine,
    };
    let platform = document
        .spec
        .gateway
        .as_local_managed()
        .map(|_| DiscoveryRequest {
            engine: engine.into(),
            compute_driver: document.spec.gateway.runtime().provider,
        });
    queries.extend(platform.clone().map(DiscoveryQuery::Engine));
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by(|left, right| left.name.cmp(&right.name));
    for sandbox in sandboxes {
        queries.push(DiscoveryQuery::Fabric(FabricRequest {
            engine: engine.into(),
            image: sandbox.image.ref_.clone(),
            requirements: FabricRequirements::for_sandbox(document, sandbox)?,
            platform: platform.clone(),
            metadata_env: sandbox
                .image
                .metadata
                .as_ref()
                .map(|metadata| metadata.env.clone()),
        }));
    }
    Ok(queries)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationStatus {
    Available,
    Unavailable,
    Unknown,
}

/// What a target read reports, given only its query's inputs. Plan and
/// onboarding share these facts; a read that needs a plan's own resources is a
/// `PlanObservation` instead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "observation", rename_all = "snake_case")]
pub enum DiscoveryObservation {
    Engine(crate::discovery::EngineObservation),
    Hardware(crate::hardware_discovery::HardwareObservation),
    Fabric(crate::discovery::FabricObservation),
    Inference(crate::inference_discovery::EndpointObservation),
    Gateway(GatewayObservation),
    Credential(crate::inference_discovery::CredentialObservation),
}

impl DiscoveryObservation {
    pub fn status(&self) -> ObservationStatus {
        match self {
            Self::Engine(value) => value.status,
            Self::Hardware(value) => value.status,
            Self::Fabric(value) => value.status,
            Self::Inference(value) => value.status,
            Self::Gateway(value) => value.status,
            Self::Credential(value) => value.status,
        }
    }
}

/// A kind of read and the observation type that answers it.
pub trait Query: PartialEq + Sized {
    type Observation;

    /// This query, if `query` is of this kind.
    fn from_query(query: &DiscoveryQuery) -> Option<&Self>;

    /// The answer, if `observation` is of this kind.
    fn from_observation(observation: &DiscoveryObservation) -> Option<&Self::Observation>;
}

macro_rules! query_kinds {
    ($($variant:ident($request:ty) => $observation:ty),+ $(,)?) => {$(
        impl Query for $request {
            type Observation = $observation;

            fn from_query(query: &DiscoveryQuery) -> Option<&Self> {
                match query {
                    DiscoveryQuery::$variant(request) => Some(request),
                    _ => None,
                }
            }

            fn from_observation(observation: &DiscoveryObservation) -> Option<&$observation> {
                match observation {
                    DiscoveryObservation::$variant(observed) => Some(observed),
                    _ => None,
                }
            }
        }
    )+};
}

query_kinds! {
    Engine(DiscoveryRequest) => EngineObservation,
    Hardware(HardwareRequest) => HardwareObservation,
    Fabric(FabricRequest) => FabricObservation,
    Inference(EndpointRequest) => EndpointObservation,
    Gateway(GatewayRequest) => GatewayObservation,
    Credential(CredentialRequest) => CredentialObservation,
}

/// Any kind of read, answered by any kind of observation.
impl Query for DiscoveryQuery {
    type Observation = DiscoveryObservation;

    fn from_query(query: &DiscoveryQuery) -> Option<&Self> {
        Some(query)
    }

    fn from_observation(observation: &DiscoveryObservation) -> Option<&Self::Observation> {
        Some(observation)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Entry {
    query: DiscoveryQuery,
    observation: DiscoveryObservation,
}

/// Observations keyed by the query that produced them. A query absent from the
/// collection was never asked; one that failed holds an unknown observation.
/// Queries are not orderable, so the collection keeps them in the order recorded.
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

    pub fn contains<Q: Query>(&self, query: &Q) -> bool {
        self.get(query).is_some()
    }

    /// The answer to `query`; a query of a kind the answer does not match is unanswered.
    pub fn get<Q: Query>(&self, query: &Q) -> Option<&Q::Observation> {
        self.entries
            .iter()
            .find(|entry| Q::from_query(&entry.query) == Some(query))
            .and_then(|entry| Q::from_observation(&entry.observation))
    }

    /// The distinct queries not yet asked, in the order given.
    pub fn missing(&self, queries: &[DiscoveryQuery]) -> Vec<DiscoveryQuery> {
        distinct(queries)
            .into_iter()
            .filter(|query| !self.contains(*query))
            .cloned()
            .collect()
    }
}

/// The queries without repeats, in the order first given.
pub fn distinct(queries: &[DiscoveryQuery]) -> Vec<&DiscoveryQuery> {
    let mut distinct: Vec<&DiscoveryQuery> = Vec::new();
    for query in queries {
        if !distinct.contains(&query) {
            distinct.push(query);
        }
    }
    distinct
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryRequest {
    pub engine: String,
    pub compute_driver: ComputeDriver,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub server_version: Option<String>,
    pub architecture: Option<String>,
    pub operating_system: Option<String>,
    pub memory_bytes: Option<u64>,
    pub cpus: Option<i64>,
}

impl EngineObservation {
    /// A read that could not be made, recorded as unknown rather than absent.
    pub fn unknown(reason: &str) -> Self {
        Self {
            status: ObservationStatus::Unknown,
            reason: Some(reason.into()),
            source: "engine_info".into(),
            server_version: None,
            architecture: None,
            operating_system: None,
            memory_bytes: None,
            cpus: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricObservation {
    pub status: ObservationStatus,
    pub reason: Option<String>,
    pub source: String,
    pub image_id: Option<String>,
    pub catalog: Option<FabricCatalog>,
    #[serde(default)]
    pub image: crate::fabric_capabilities::ImageMetadata,
    #[serde(default)]
    pub compatibility: Option<crate::fabric_capabilities::CompatibilityReport>,
}

impl FabricObservation {
    /// A read that could not be made, recorded as unknown rather than absent.
    pub fn unknown(reason: &str) -> Self {
        Self {
            status: ObservationStatus::Unknown,
            reason: Some(reason.into()),
            source: "engine_image_inspect".into(),
            image_id: None,
            catalog: None,
            image: Default::default(),
            compatibility: None,
        }
    }
}

/// Compatibility of a managed inference image with the compiled runtime contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeImageObservation {
    pub status: ObservationStatus,
    pub source: String,
    pub required_version: String,
}
