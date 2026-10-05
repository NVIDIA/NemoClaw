// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Read provider observations through an isolated, disposable OpenTofu plan.
//!
//! A [`DiscoveryQuery`] names a read by everything that determines its answer,
//! and [`DiscoveryObservations`] holds what each returned, so an observation
//! can never be mistaken for one about a different engine, image, or endpoint.
//! A [`DiscoverySource`] answers queries: [`DiscoverySession`] reads the real
//! target, and [`RecordedDiscovery`] replays recorded observations, which lets
//! callers test their decisions against any hardware without owning it.
use crate::{
    CancellationToken, EnvironmentSecrets, Error,
    bundle::Bundle,
    config::{ComputeDriver, ConfigError, Document, Gateway},
    discovery::{
        DiscoveryRequest, EngineObservation, FabricObservation, GatewayObservation,
        ObservationStatus,
    },
    hardware_discovery::HardwareObservation,
    inference_discovery::{
        CredentialObservation, EndpointObservation, EndpointRequest, observe_credential,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{future::Future, path::Path};

/// Rounds of observation after which [`discover`] concludes the queries never settle.
const MAX_ROUNDS: usize = 8;

/// A read of the target, identified by everything that determines its answer.
/// The provider reads are independent, so OpenTofu may schedule them
/// concurrently; the gateway and credential reads are made separately.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiscoveryQuery {
    Engine(DiscoveryRequest),
    Hardware {
        engine: String,
    },
    Fabric {
        engine: String,
        image: String,
    },
    Inference(EndpointRequest),
    Gateway {
        gateway: Gateway,
        compute_drivers: Vec<ComputeDriver>,
    },
    /// Whether a credential reference resolves locally; never its value.
    Credential {
        reference: String,
    },
}

pub use crate::discovery::DiscoveryObservation;
impl DiscoveryQuery {
    pub(crate) fn data(&self) -> Result<(&'static str, Value), Error> {
        Ok(match self {
            Self::Engine(request) => (
                "engine_capabilities",
                json!({"engine":literal(&request.engine),"compute_driver":request.compute_driver}),
            ),
            Self::Hardware { engine } => ("target_hardware", json!({"engine":literal(engine)})),
            Self::Fabric { engine, image } => (
                "fabric_capabilities",
                json!({"engine":literal(engine),"image":literal(image)}),
            ),
            Self::Inference(request) => {
                request.validate()?;
                (
                    "inference_capabilities",
                    json!({"endpoint":literal(&request.endpoint),"api":request.api,"credential_env":request.credential_env}),
                )
            }
            Self::Gateway { .. } | Self::Credential { .. } => {
                return Err(Error::State("the query is not a provider data source"));
            }
        })
    }
    fn decode(&self, value: Value) -> Result<DiscoveryObservation, Error> {
        match self {
            Self::Engine(_) => serde_json::from_value(value).map(DiscoveryObservation::Engine),
            Self::Hardware { .. } => {
                serde_json::from_value(value).map(DiscoveryObservation::Hardware)
            }
            Self::Fabric { .. } => serde_json::from_value(value).map(DiscoveryObservation::Fabric),
            Self::Inference(_) => {
                serde_json::from_value(value).map(DiscoveryObservation::Inference)
            }
            Self::Gateway { .. } | Self::Credential { .. } => {
                return Err(Error::State("the query is not a provider data source"));
            }
        }
        .map_err(|_| Error::State("invalid discovery observation"))
    }

    fn is_provider_data_source(&self) -> bool {
        !matches!(self, Self::Gateway { .. } | Self::Credential { .. })
    }

    /// The observation recorded when this read could not be made. A failed
    /// read is unknown, never absence.
    pub fn unknown(&self, reason: &str) -> DiscoveryObservation {
        match self {
            Self::Engine(_) => DiscoveryObservation::Engine(EngineObservation::unknown(reason)),
            Self::Hardware { .. } => {
                DiscoveryObservation::Hardware(HardwareObservation::unknown_because(reason))
            }
            Self::Fabric { .. } => DiscoveryObservation::Fabric(FabricObservation::unknown(reason)),
            Self::Inference(_) => {
                DiscoveryObservation::Inference(EndpointObservation::unknown(reason))
            }
            Self::Gateway { .. } => {
                DiscoveryObservation::Gateway(GatewayObservation::unknown(reason))
            }
            Self::Credential { reference } => {
                DiscoveryObservation::Credential(CredentialObservation {
                    reference: reference.clone(),
                    status: ObservationStatus::Unknown,
                    reason: Some(reason.into()),
                })
            }
        }
    }
}

/// The compute drivers the gateway must support for `document`'s sandboxes.
pub(crate) fn gateway_drivers(document: &Document) -> std::collections::BTreeSet<ComputeDriver> {
    document
        .spec
        .sandboxes
        .iter()
        .map(|sandbox| sandbox.runtime.provider)
        .collect()
}

/// The reads a plan makes of the target for `document`, in the order it names
/// them: the gateway, each external inference endpoint, the hardware of every
/// engine that services or a managed gateway use, a managed gateway's engine,
/// and one image read per sandbox. The image reads are per sandbox, sorted by
/// sandbox name, because each carries that sandbox's own requirements.
pub fn plan_queries(document: &Document) -> Result<Vec<DiscoveryQuery>, ConfigError> {
    let mut queries = vec![DiscoveryQuery::Gateway {
        gateway: document.spec.gateway.clone(),
        compute_drivers: gateway_drivers(document).into_iter().collect(),
    }];
    queries.extend(
        crate::inference_discovery::endpoint_requests(document)
            .map_err(|_| ConfigError::new("inference discovery inputs are invalid"))?
            .into_iter()
            .map(DiscoveryQuery::Inference),
    );
    let mut engines = crate::services::discovery_engines(document)?;
    if let Some(gateway) = document.spec.gateway.as_managed() {
        engines.insert(gateway.engine.clone());
    }
    queries.extend(
        engines
            .into_iter()
            .map(|engine| DiscoveryQuery::Hardware { engine }),
    );
    let engine = match &document.spec.gateway {
        Gateway::Managed(gateway) => &gateway.engine,
        Gateway::External(gateway) => &gateway.engine,
    };
    if document.spec.gateway.as_managed().is_some() {
        queries.push(DiscoveryQuery::Engine(DiscoveryRequest {
            engine: engine.clone(),
            compute_driver: document.spec.sandboxes[0].runtime.provider,
        }));
    }
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by(|left, right| left.name.cmp(&right.name));
    queries.extend(sandboxes.into_iter().map(|sandbox| DiscoveryQuery::Fabric {
        engine: engine.clone(),
        image: sandbox.image.ref_.clone(),
    }));
    Ok(queries)
}

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

    pub fn hardware(&self, engine: &str) -> Option<&HardwareObservation> {
        match self.get(&DiscoveryQuery::Hardware {
            engine: engine.into(),
        }) {
            Some(DiscoveryObservation::Hardware(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn fabric(&self, engine: &str, image: &str) -> Option<&FabricObservation> {
        match self.get(&DiscoveryQuery::Fabric {
            engine: engine.into(),
            image: image.into(),
        }) {
            Some(DiscoveryObservation::Fabric(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn inference(&self, request: &EndpointRequest) -> Option<&EndpointObservation> {
        match self.get(&DiscoveryQuery::Inference(request.clone())) {
            Some(DiscoveryObservation::Inference(observation)) => Some(observation),
            _ => None,
        }
    }

    pub fn gateway(
        &self,
        gateway: &Gateway,
        compute_drivers: &[ComputeDriver],
    ) -> Option<&GatewayObservation> {
        match self.get(&DiscoveryQuery::Gateway {
            gateway: gateway.clone(),
            compute_drivers: compute_drivers.to_vec(),
        }) {
            Some(DiscoveryObservation::Gateway(observation)) => Some(observation),
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

/// Answers queries. The result has an observation for every distinct query
/// asked, unknown for a read that could not be made. An error means the whole
/// round was abandoned, which is only cancellation.
pub trait DiscoverySource {
    fn observe(
        &mut self,
        queries: &[DiscoveryQuery],
        cancel: &CancellationToken,
    ) -> impl Future<Output = Result<DiscoveryObservations, Error>>;
}

/// Replays recorded observations. Anything it does not hold is unknown.
pub struct RecordedDiscovery(DiscoveryObservations);

impl RecordedDiscovery {
    pub fn new(observations: DiscoveryObservations) -> Self {
        Self(observations)
    }
}

impl DiscoverySource for RecordedDiscovery {
    async fn observe(
        &mut self,
        queries: &[DiscoveryQuery],
        _cancel: &CancellationToken,
    ) -> Result<DiscoveryObservations, Error> {
        let mut observed = DiscoveryObservations::new();
        for query in queries {
            let observation = self
                .0
                .get(query)
                .cloned()
                .unwrap_or_else(|| query.unknown("no recorded observation"));
            observed.record(query.clone(), observation);
        }
        Ok(observed)
    }
}

/// Observe whatever `queries` asks for until nothing it asks for is missing.
/// `queries` sees the observations so that a read can depend on an earlier one.
pub async fn discover<S: DiscoverySource>(
    source: &mut S,
    observations: &mut DiscoveryObservations,
    mut queries: impl FnMut(&DiscoveryObservations) -> Vec<DiscoveryQuery>,
    cancel: &CancellationToken,
) -> Result<(), Error> {
    for _ in 0..MAX_ROUNDS {
        let missing = observations.missing(&queries(observations));
        if missing.is_empty() {
            return Ok(());
        }
        observations.merge(source.observe(&missing, cancel).await?);
    }
    Err(Error::State("discovery did not settle"))
}

pub struct DiscoverySession {
    bundle: Bundle,
    directory: tempfile::TempDir,
    initialized: bool,
}

impl DiscoverySession {
    pub fn new(bundle_directory: &Path) -> Result<Self, Error> {
        Self::with_bundle(Bundle::open(bundle_directory)?)
    }

    fn with_bundle(bundle: Bundle) -> Result<Self, Error> {
        Ok(Self {
            bundle,
            directory: tempfile::tempdir()
                .map_err(|_| Error::State("cannot create discovery directory"))?,
            initialized: false,
        })
    }

    /// Reuse the strict gateway metadata source through its authenticated channel.
    /// A failure is an unknown observation, never absence.
    pub async fn gateway(
        &mut self,
        gateway: &crate::config::Gateway,
        required: &[crate::config::ComputeDriver],
        cancel: &CancellationToken,
    ) -> Result<crate::discovery::GatewayObservation, Error> {
        let value = tokio::time::timeout(
            std::time::Duration::from_secs(35),
            self.query_configured(
                "gateway_capabilities",
                json!({"required_compute_drivers":required}),
                crate::compile::gateway_provider(gateway),
                cancel,
            ),
        )
        .await
        .map_err(|_| Error::State("gateway discovery timed out"))??;
        serde_json::from_value(value).map_err(|_| Error::State("invalid gateway observation"))
    }

    /// Deduplicate identical reads and execute independent observations in one plan.
    /// Results retain the caller's order, including repeated requests.
    pub async fn batch(
        &mut self,
        queries: &[DiscoveryQuery],
        cancel: &CancellationToken,
    ) -> Result<Vec<DiscoveryObservation>, Error> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if queries.is_empty() {
            return Ok(Vec::new());
        }
        if queries.len() > 128 {
            return Err(Error::State("too many discovery queries"));
        }
        let mut graph = self.graph(json!({}));
        let mut unique = std::collections::BTreeMap::new();
        let mut names = Vec::new();
        for query in queries {
            let (kind, inputs) = query.data()?;
            let key = format!("{kind}:{inputs}");
            let next = format!("query_{}", unique.len());
            let name = unique.entry(key).or_insert(next).clone();
            let source = format!("nemoclaw_{kind}");
            graph["data"][&source][&name] = inputs;
            graph["output"]["observation"]["value"][&name] =
                json!(format!("${{data.{source}.{name}.observation_json}}"));
            names.push(name);
        }
        let plan = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.execute_graph(&graph, cancel),
        )
        .await
        .map_err(|_| Error::State("provider discovery timed out"))??;
        queries
            .iter()
            .zip(names)
            .map(|(query, name)| {
                let encoded = plan["planned_values"]["outputs"]["observation"]["value"][&name]
                    .as_str()
                    .ok_or(Error::State("discovery observation is unknown"))?;
                query.decode(
                    serde_json::from_str(encoded)
                        .map_err(|_| Error::State("invalid discovery observation"))?,
                )
            })
            .collect()
    }

    fn graph(&self, provider: Value) -> Value {
        json!({"terraform": {"required_version": format!("= {}",crate::compile::OPENTOFU_VERSION), "required_providers":{"nemoclaw":{"source":crate::compile::PROVIDER_ADDRESS,"version":format!("= {}",self.bundle.manifest.version)}}},"provider":{"nemoclaw":provider}})
    }

    async fn query_configured(
        &mut self,
        kind: &str,
        inputs: Value,
        provider: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let source = format!("nemoclaw_{kind}");
        let mut graph = self.graph(provider);
        graph["data"][&source]["current"] = inputs;
        graph["output"]["observation"]["value"] =
            json!(format!("${{data.{source}.current.observation_json}}"));
        let plan = self.execute_graph(&graph, cancel).await?;
        let observed = plan
            .pointer("/planned_values/outputs/observation/value")
            .and_then(Value::as_str)
            .ok_or(Error::State("discovery observation is unknown"))?;
        serde_json::from_str(observed).map_err(|_| Error::State("invalid discovery observation"))
    }
    async fn execute_graph(
        &mut self,
        graph: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value, Error> {
        let directory = self.directory.path();
        crate::state::save_json(&directory.join("main.tf.json"), &graph)?;
        let mirror = self
            .bundle
            .directory
            .join("providers")
            .to_string_lossy()
            .replace('\\', "/");
        let quoted = serde_json::to_string(&mirror).expect("string path");
        crate::state::atomic_write(
            &directory.join("providers.tfrc"),
            format!("provider_installation {{ filesystem_mirror {{ path = {quoted} }} }}\n")
                .as_bytes(),
        )?;
        let environment = crate::state::schema_environment(directory);
        if !self.initialized {
            crate::process::run(
                directory,
                &self.bundle.tofu(),
                &["init", "-backend=false", "-input=false", "-no-color"],
                &environment,
                cancel,
            )
            .await?;
            self.initialized = true;
        }
        crate::process::run(
            directory,
            &self.bundle.tofu(),
            &["plan", "-input=false", "-no-color", "-out=discovery.plan"],
            &environment,
            cancel,
        )
        .await?;
        let bytes = crate::process::run(
            directory,
            &self.bundle.tofu(),
            &["show", "-json", "discovery.plan"],
            &environment,
            cancel,
        )
        .await?;
        serde_json::from_slice(&bytes).map_err(|_| Error::State("invalid discovery plan"))
    }
}

impl DiscoverySource for DiscoverySession {
    /// One provider plan serves every provider read; the gateway read and the
    /// local credential check are separate. A failed read is recorded as
    /// unknown, and only cancellation abandons the round.
    async fn observe(
        &mut self,
        queries: &[DiscoveryQuery],
        cancel: &CancellationToken,
    ) -> Result<DiscoveryObservations, Error> {
        let mut distinct: Vec<&DiscoveryQuery> = Vec::new();
        for query in queries {
            if !distinct.contains(&query) {
                distinct.push(query);
            }
        }
        let mut observed = DiscoveryObservations::new();
        let provider: Vec<DiscoveryQuery> = distinct
            .iter()
            .filter(|query| query.is_provider_data_source())
            .map(|query| (*query).clone())
            .collect();
        match self.batch(&provider, cancel).await {
            Ok(observations) => {
                for (query, observation) in provider.into_iter().zip(observations) {
                    observed.record(query, observation);
                }
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(_) => {
                for query in provider {
                    let unknown = query.unknown("provider discovery failed");
                    observed.record(query, unknown);
                }
            }
        }
        for query in distinct {
            let observation = match query {
                DiscoveryQuery::Gateway {
                    gateway,
                    compute_drivers,
                } => match self.gateway(gateway, compute_drivers, cancel).await {
                    Ok(observation) => DiscoveryObservation::Gateway(observation),
                    Err(Error::Cancelled) => return Err(Error::Cancelled),
                    Err(_) => query.unknown("gateway discovery failed"),
                },
                DiscoveryQuery::Credential { reference } => DiscoveryObservation::Credential(
                    observe_credential(&EnvironmentSecrets, reference),
                ),
                _ => continue,
            };
            observed.record(query.clone(), observation);
        }
        Ok(observed)
    }
}

pub(crate) fn literal(value: &str) -> String {
    value.replace("${", "$${").replace("%{", "%%{")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt};

    fn fixture() -> (tempfile::TempDir, DiscoverySession) {
        let bundle = tempfile::tempdir().unwrap();
        fs::create_dir(bundle.path().join("libexec")).unwrap();
        let executable = bundle.path().join("libexec/tofu");
        fs::write(&executable, r#"#!/bin/sh
printf '%s\n' "$1" >> calls
case "$1" in
  init) exit 0 ;;
  plan) test -f main.tf.json; exit $? ;;
  show) printf '%s\n' '{"planned_values":{"outputs":{"observation":{"value":{"query_0":"{\"status\":\"unknown\",\"reason\":\"engine_unreachable\",\"source\":\"engine_info\",\"server_version\":null,\"architecture\":null,\"operating_system\":null,\"memory_bytes\":null,\"cpus\":null}"}}}}}' ;;
  *) exit 17 ;;
esac
"#).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let session = DiscoverySession::with_bundle(Bundle {
            directory: bundle.path().into(),
            manifest: crate::bundle::Manifest {
                version: "0.1.0".into(),
                rust: "test".into(),
                opentofu: crate::compile::OPENTOFU_VERSION.into(),
                files: BTreeMap::new(),
            },
        })
        .unwrap();
        (bundle, session)
    }

    #[tokio::test]
    async fn batch_deduplicates_reads_in_one_plan_and_preserves_input_order() {
        let (_bundle, mut session) = fixture();
        let result = json!({"status":"unknown", "reason":null, "source":"fixture", "reachable":null, "authentication":"unknown", "models":[], "api_verified":false});
        let plan = json!({"planned_values":{"outputs":{"observation":{"value":{"query_0":result.to_string()}}}}});
        let executable = session.bundle.tofu();
        fs::write(&executable, format!("#!/bin/sh\nprintf '%s\\n' \"$1\" >> calls\nif [ \"$1\" = show ]; then cat <<'RESULT'\n{plan}\nRESULT\nfi\n")).unwrap();
        let query = DiscoveryQuery::Inference(crate::inference_discovery::EndpointRequest {
            endpoint: "https://example.test/v1".into(),
            api: crate::config::InferenceApi::OpenaiCompletions,
            credential_env: None,
        });
        let results = session
            .batch(&[query.clone(), query], &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0], results[1]);
        let graph: Value = serde_json::from_slice(
            &fs::read(session.directory.path().join("main.tf.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            graph["data"]["nemoclaw_inference_capabilities"]
                .as_object()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            fs::read_to_string(session.directory.path().join("calls")).unwrap(),
            "init\nplan\nshow\n"
        );
        assert!(graph.get("resource").is_none());
    }

    #[tokio::test]
    async fn discovery_reuses_initialization_but_refreshes_observations_without_apply_or_state() {
        let (_bundle, mut session) = fixture();
        let directory = session.directory.path().to_owned();
        for engine in ["unix:///first.sock", "unix:///second.sock"] {
            let request = crate::discovery::DiscoveryRequest {
                engine: engine.into(),
                compute_driver: crate::config::ComputeDriver::Docker,
            };
            let observed = session
                .observe(
                    &[DiscoveryQuery::Engine(request.clone())],
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(
                observed.engine(&request).map(|engine| engine.status),
                Some(ObservationStatus::Unknown)
            );
            let graph: Value =
                serde_json::from_slice(&fs::read(directory.join("main.tf.json")).unwrap()).unwrap();
            assert_eq!(
                graph["data"]["nemoclaw_engine_capabilities"]["query_0"]["engine"],
                engine
            );
            assert!(graph.get("resource").is_none());
        }
        assert_eq!(
            fs::read_to_string(directory.join("calls")).unwrap(),
            "init\nplan\nshow\nplan\nshow\n"
        );
        assert!(!directory.join("terraform.tfstate").exists());
        drop(session);
        assert!(!directory.exists());
    }

    #[tokio::test]
    async fn cancelled_discovery_does_not_launch_opentofu() {
        let (_bundle, mut session) = fixture();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let query = DiscoveryQuery::Engine(crate::discovery::DiscoveryRequest {
            engine: "unix:///first.sock".into(),
            compute_driver: crate::config::ComputeDriver::Docker,
        });
        assert!(matches!(
            session.observe(&[query], &cancel).await,
            Err(Error::Cancelled)
        ));
        assert!(!session.directory.path().join("calls").exists());
    }

    /// Replace the fake `tofu` of a session's bundle.
    fn write_tofu(session: &DiscoverySession, script: &str) {
        fs::write(session.bundle.tofu(), script).unwrap();
    }

    fn docker_engine() -> crate::discovery::DiscoveryRequest {
        crate::discovery::DiscoveryRequest {
            engine: "unix:///var/run/docker.sock".into(),
            compute_driver: crate::config::ComputeDriver::Docker,
        }
    }

    fn external_gateway() -> Gateway {
        Gateway::External(crate::config::ExternalGateway {
            endpoint: "http://127.0.0.1:17681".into(),
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn a_failed_round_leaves_every_query_unknown_rather_than_unasked() {
        let (_bundle, mut session) = fixture();
        write_tofu(
            &session,
            "#!/bin/sh\nprintf '%s\\n' \"$1\" >> calls\ncase \"$1\" in init) exit 0 ;; plan) exit 1 ;; *) exit 17 ;; esac\n",
        );
        let engine = docker_engine();
        let drivers = vec![crate::config::ComputeDriver::Docker];
        let observed = session
            .observe(
                &[
                    DiscoveryQuery::Engine(engine.clone()),
                    DiscoveryQuery::Hardware {
                        engine: engine.engine.clone(),
                    },
                    DiscoveryQuery::Gateway {
                        gateway: external_gateway(),
                        compute_drivers: drivers.clone(),
                    },
                ],
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let engine_read = observed
            .engine(&engine)
            .expect("the engine read is recorded");
        let hardware_read = observed
            .hardware(&engine.engine)
            .expect("the hardware read is recorded");
        let gateway_read = observed
            .gateway(&external_gateway(), &drivers)
            .expect("the gateway read is recorded");
        assert_eq!(engine_read.status, ObservationStatus::Unknown);
        assert_eq!(hardware_read.status, ObservationStatus::Unknown);
        assert_eq!(gateway_read.status, ObservationStatus::Unknown);
        assert!(engine_read.reason.is_some() && gateway_read.reason.is_some());
    }

    #[tokio::test]
    async fn credential_availability_is_read_locally_and_never_records_the_value() {
        let (_bundle, mut session) = fixture();
        // PATH is set in every test process; the other name never is.
        let never_set = "NEMOCLAW_TEST_CREDENTIAL_NEVER_SET";
        let observed = session
            .observe(
                &[
                    DiscoveryQuery::Credential {
                        reference: "PATH".into(),
                    },
                    DiscoveryQuery::Credential {
                        reference: never_set.into(),
                    },
                ],
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            observed
                .credential("PATH")
                .map(|credential| credential.status),
            Some(ObservationStatus::Available)
        );
        assert_eq!(
            observed
                .credential(never_set)
                .map(|credential| credential.status),
            Some(ObservationStatus::Unavailable)
        );
        let recorded = serde_json::to_string(&observed).unwrap();
        assert!(!recorded.contains(&std::env::var("PATH").unwrap()));
        assert!(!session.directory.path().join("calls").exists());
    }

    #[tokio::test]
    async fn one_round_serves_provider_reads_the_gateway_read_and_credentials() {
        let (_bundle, mut session) = fixture();
        let engine = docker_engine();
        let drivers = vec![crate::config::ComputeDriver::Docker];
        let engine_observation = crate::discovery::EngineObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "fixture".into(),
            server_version: Some("27.3.1".into()),
            architecture: Some("aarch64".into()),
            operating_system: Some("linux".into()),
            memory_bytes: None,
            cpus: None,
        };
        let gateway_observation = crate::discovery::GatewayObservation {
            status: ObservationStatus::Available,
            reason: None,
            source: "openshell_gateway_info".into(),
            capabilities: Some(crate::discovery::GatewayCapabilities {
                gateway_version: "1.2.3".into(),
                compute_drivers: vec![["docker".to_string()].into()],
            }),
            compatible: Some(true),
        };
        let directory = session.directory.path().to_owned();
        let output = |value: Value| {
            json!({"planned_values": {"outputs": {"observation": {"value": value}}}}).to_string()
        };
        fs::write(
            directory.join("provider.json"),
            output(json!({"query_0": serde_json::to_string(&engine_observation).unwrap()})),
        )
        .unwrap();
        fs::write(
            directory.join("gateway.json"),
            output(json!(serde_json::to_string(&gateway_observation).unwrap())),
        )
        .unwrap();
        // The provider round is the first `show`, the gateway read the second.
        write_tofu(
            &session,
            "#!/bin/sh\nprintf '%s\\n' \"$1\" >> calls\ncase \"$1\" in\n  init|plan) exit 0 ;;\n  show) if [ \"$(grep -c '^show$' calls)\" = 1 ]; then cat provider.json; else cat gateway.json; fi ;;\n  *) exit 17 ;;\nesac\n",
        );
        let observed = session
            .observe(
                &[
                    DiscoveryQuery::Engine(engine.clone()),
                    DiscoveryQuery::Gateway {
                        gateway: external_gateway(),
                        compute_drivers: drivers.clone(),
                    },
                    DiscoveryQuery::Credential {
                        reference: "PATH".into(),
                    },
                ],
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(observed.engine(&engine), Some(&engine_observation));
        assert_eq!(
            observed.gateway(&external_gateway(), &drivers),
            Some(&gateway_observation)
        );
        assert_eq!(
            observed
                .credential("PATH")
                .map(|credential| credential.status),
            Some(ObservationStatus::Available)
        );
        // One initialization serves both plans.
        assert_eq!(
            fs::read_to_string(directory.join("calls")).unwrap(),
            "init\nplan\nshow\nplan\nshow\n"
        );
    }
}
