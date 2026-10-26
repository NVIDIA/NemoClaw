// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::discovery::{EngineObservation, GATEWAY_PREREQUISITES};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiscoveryScope {
    Runtime,
    Deployment,
}

/// Prior state and validated plan facts, never a separate resource scan or adoption.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInventoryEntry {
    pub address: String,
    pub scope: DiscoveryScope,
    /// Present in prior state or the refreshed plan's before value; not a health assertion.
    pub existed: bool,
    pub planned_actions: Vec<String>,
    /// OpenTofu refresh differences, including computed metadata changes.
    pub drifted: bool,
    /// The owner's teardown compiler retains this established resource.
    pub retained: bool,
    /// An established resource has an unchanged plan and no reported drift.
    pub reuse_planned: bool,
}
/// Authored identity of a provider whose native registration uses a scoped key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceSource {
    pub name: String,
    pub path: String,
}

impl OperationResult {
    pub(super) fn describe_sources(&mut self, document: &Document) -> Result<(), Error> {
        for provider in document.selected_providers()? {
            if provider.key != provider.name {
                self.resource_sources.insert(
                    format!(
                        "{}.inference_{}",
                        crate::compile::resource_type("inference"),
                        provider.key
                    ),
                    ResourceSource {
                        name: provider.name.to_owned(),
                        path: provider.path.clone(),
                    },
                );
            }
        }
        Ok(())
    }
}

pub use crate::discovery::DiscoveryObservation;

/// A read only a plan can make: its inputs or its meaning depend on resources
/// in the same plan, so an onboarding discovery session never reports one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "observation", rename_all = "snake_case")]
pub enum PlanObservation {
    /// Checked against the image a resource in the same apply acquires.
    RuntimeImage(crate::discovery::RuntimeImageObservation),
    /// Readiness of a service the same apply installs.
    Service { ready: Option<bool>, source: String },
    /// A read whose value OpenTofu cannot compute until apply.
    Unresolved { category: String },
}

/// One read in a plan's report. Both kinds keep their own `kind` tag.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
#[expect(
    clippy::large_enum_variant,
    reason = "a report holds a few reads; boxing would only add indirection to every match"
)]
pub enum ReportedObservation {
    Discovery(DiscoveryObservation),
    Plan(PlanObservation),
}

/// Safe, validated query inputs. This allowlist intentionally excludes specs,
/// credentials, local credential file paths, and provider resource identity.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<crate::config::InferenceApi>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_env: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compute_driver: Option<crate::config::ComputeDriver>,
}
impl DiscoveryTarget {
    fn from_values(value: &Value) -> Self {
        let text = |name: &str| value[name].as_str().map(str::to_owned);
        Self {
            engine: text("engine"),
            image: text("image"),
            endpoint: text("endpoint"),
            credential_env: text("credential_env"),
            api: serde_json::from_value(value["api"].clone()).ok(),
            compute_driver: serde_json::from_value(value["compute_driver"].clone()).ok(),
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryReport {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub targets: BTreeMap<String, DiscoveryTarget>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub observations: BTreeMap<String, ReportedObservation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub credentials: Vec<crate::inference_discovery::CredentialObservation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<ResourceInventoryEntry>,
}
impl DiscoveryReport {
    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
            && self.observations.is_empty()
            && self.credentials.is_empty()
            && self.resources.is_empty()
    }
    /// Unresolved prerequisites that prevent a complete resource plan.
    pub fn deferred(&self) -> Vec<String> {
        self.unresolved(false)
    }
    /// Supplemental catalog or apply-time readiness facts, not planning gates.
    pub fn unverified(&self) -> Vec<String> {
        self.unresolved(true)
    }
    fn unresolved(&self, advisory: bool) -> Vec<String> {
        self.observations
            .iter()
            .filter_map(|(name, observation)| {
                use crate::discovery::ObservationStatus::Available;
                use {DiscoveryObservation as Discovery, ReportedObservation as Reported};
                let supplemental = match observation {
                    Reported::Discovery(Discovery::Inference(_))
                    | Reported::Plan(PlanObservation::Service { .. }) => true,
                    Reported::Plan(PlanObservation::Unresolved { category }) => {
                        matches!(category.as_str(), "inference" | "service")
                    }
                    _ => false,
                };
                if supplemental != advisory {
                    return None;
                }
                let resolved = match observation {
                    Reported::Discovery(Discovery::Gateway(value)) => {
                        value.status == Available && value.compatible == Some(true)
                    }
                    Reported::Discovery(Discovery::Fabric(value)) => {
                        value.status == Available
                            && value.compatibility.as_ref().is_some_and(|compatibility| {
                                compatibility.status
                                    == crate::fabric_capabilities::Support::Supported
                            })
                    }
                    Reported::Discovery(value) => value.status() == Available,
                    Reported::Plan(PlanObservation::RuntimeImage(value)) => {
                        value.status == Available
                    }
                    Reported::Plan(PlanObservation::Service { ready, .. }) => *ready == Some(true),
                    Reported::Plan(PlanObservation::Unresolved { .. }) => false,
                };
                (!resolved).then(|| unverified_message(name))
            })
            .collect()
    }
    pub(super) fn gateway_target(&mut self, document: &Document) {
        if self.observations.contains_key("gateway") {
            self.targets.insert(
                "gateway".into(),
                DiscoveryTarget {
                    endpoint: Some(document.spec.gateway.endpoint().into()),
                    credential_env: document
                        .spec
                        .gateway
                        .credential()
                        .map(|reference| reference.env.clone()),
                    ..Default::default()
                },
            );
        }
    }
}
/// The prerequisite read's observation name, for its address.
fn prerequisites(address: &str) -> Option<String> {
    let source = crate::compile::data_source_type(GATEWAY_PREREQUISITES);
    (address == format!("data.{source}.current")).then(|| GATEWAY_PREREQUISITES.to_owned())
}
fn observation_name(address: &str) -> Option<String> {
    if address == "data.host_engine.current" {
        Some("engine".into())
    } else if address == "data.openshell_gateway.current" {
        Some("gateway".into())
    } else {
        [
            "data.fabric_harnesses.",
            "data.host_image.",
            "data.host_engine.",
        ]
        .iter()
        .find_map(|prefix| address.strip_prefix(prefix).map(str::to_owned))
    }
}
pub(super) fn category(name: &str) -> &'static str {
    if name == "engine" {
        "engine"
    } else if name == "gateway" {
        "gateway"
    } else if name.starts_with("runtime_image_") {
        "runtime_image"
    } else if name.starts_with("target_") {
        "hardware"
    } else if name.starts_with("endpoint_") {
        "inference"
    } else if name.starts_with("service_") {
        "service"
    } else {
        "fabric"
    }
}
pub(super) fn unverified_message(name: &str) -> String {
    match category(name){
        "engine"=>"Selected engine capabilities are unverified; provider discovery could not establish prerequisites.",
        "gateway"=>"Gateway version and compute-driver compatibility remain unverified until its provider observation completes.",
        "runtime_image"=>"Runtime image compatibility remains unverified until the image is acquired and its runtime specification is checked.",
        "hardware"=>"Target hardware inventory remains unverified; requirements are still checked by the owning runtime.",
        "inference"=>"Inference endpoint catalog remains unverified from the control host; sandbox connectivity and generation APIs require their own checks.",
        "service"=>"Managed inference readiness is checked during apply; plan does not establish current service readiness.",
        _=>"Selected image Fabric capabilities are unverified; image metadata or compatibility is incomplete. Runtime adapter checks remain required.",
    }.into()
}
impl Plan {
    /// A partially unknown output map omits its value in OpenTofu JSON. Retain
    /// completed data reads from planned resources, without reading state again.
    pub(super) fn discovery_values(&self) -> BTreeMap<String, Value> {
        let mut result: BTreeMap<_, _> = self
            .planned_values
            .pointer("/outputs/discovery/value")
            .and_then(Value::as_object)
            .map(|values| {
                values
                    .iter()
                    .map(|(name, value)| (name.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(resources) = self
            .planned_values
            .pointer("/root_module/resources")
            .and_then(Value::as_array)
        {
            for resource in resources {
                let Some(address) = resource["address"].as_str() else {
                    continue;
                };
                if let Some(name) = observation_name(address).or_else(|| prerequisites(address)) {
                    result
                        .entry(name)
                        .or_insert_with(|| resource["values"]["observation_json"].clone());
                } else if let Some(name) = crate::services::provider_types::READINESS_TYPES
                    .iter()
                    .find_map(|(_, source)| address.strip_prefix(&format!("data.{source}.")))
                {
                    result.insert(
                        format!("service_{name}"),
                        json!({"ready":resource["values"]["ready"]}),
                    );
                }
            }
        }
        for change in &self.resource_changes {
            if change.mode.as_deref() == Some("data")
                && let Some(name) =
                    observation_name(&change.address).or_else(|| prerequisites(&change.address))
            {
                result
                    .entry(name)
                    .or_insert_with(|| change.change.after["observation_json"].clone());
            }
        }
        // A managed gateway's engine facts and its prerequisites are separate
        // reads, reported as one engine observation; until both complete the
        // engine is unresolved.
        if let Some(prerequisites) = result.remove(GATEWAY_PREREQUISITES) {
            let engine = result
                .get("engine")
                .and_then(Value::as_str)
                .and_then(|engine| serde_json::from_str::<EngineObservation>(engine).ok());
            if let Some(engine) = engine {
                let merged = prerequisites
                    .as_str()
                    .and_then(|encoded| serde_json::from_str(encoded).ok())
                    .map(|prerequisites| {
                        Value::String(
                            serde_json::to_string(&engine.with_prerequisites(prerequisites))
                                .expect("engine observation"),
                        )
                    });
                result.insert("engine".into(), merged.unwrap_or(Value::Null));
            }
        }
        result
    }
    /// Called only after the existing ownership, drift and transition checks pass.
    pub(super) fn discovery_report(
        &self,
        runtime: &BTreeSet<String>,
        bindings: &BTreeMap<String, StateBinding>,
        retained: &BTreeSet<String>,
    ) -> Result<DiscoveryReport, Error> {
        let mut report = DiscoveryReport::default();
        if let Some(resources) = self
            .planned_values
            .pointer("/root_module/resources")
            .and_then(Value::as_array)
        {
            for resource in resources {
                if let Some(name) = resource["address"].as_str().and_then(observation_name) {
                    report
                        .targets
                        .insert(name, DiscoveryTarget::from_values(&resource["values"]));
                }
            }
        }
        for change in &self.resource_changes {
            if change.mode.as_deref() == Some("data")
                && let Some(name) = observation_name(&change.address)
            {
                report
                    .targets
                    .entry(name)
                    .or_insert_with(|| DiscoveryTarget::from_values(&change.change.after));
            }
        }
        for (name, value) in self.discovery_values() {
            let observation = if category(&name) == "service" {
                ReportedObservation::Plan(PlanObservation::Service {
                    ready: value["ready"].as_bool(),
                    source: "service_readiness".into(),
                })
            } else if let Some(encoded) = value.as_str() {
                let invalid = |_| Error::State("invalid typed provider discovery observation");
                use {DiscoveryObservation as Discovery, ReportedObservation as Reported};
                match category(&name) {
                    "engine" => Reported::Discovery(Discovery::Engine(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    )),
                    "gateway" => Reported::Discovery(Discovery::Gateway(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    )),
                    "hardware" => Reported::Discovery(Discovery::Hardware(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    )),
                    "runtime_image" => Reported::Plan(PlanObservation::RuntimeImage(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    )),
                    "inference" => Reported::Discovery(Discovery::Inference(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    )),
                    _ => Reported::Discovery(Discovery::Fabric(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    )),
                }
            } else {
                ReportedObservation::Plan(PlanObservation::Unresolved {
                    category: category(&name).into(),
                })
            };
            report.observations.insert(name, observation);
        }
        for change in &self.resource_changes {
            if change.mode.as_deref() == Some("data") {
                continue;
            }
            let existed = bindings.contains_key(&change.address) || !change.change.before.is_null();
            let drifted = self
                .resource_drift
                .iter()
                .any(|drift| drift.address == change.address && drift.change.actions != ["no-op"]);
            report.resources.push(ResourceInventoryEntry {
                address: change.address.clone(),
                scope: if runtime.contains(&change.address) {
                    DiscoveryScope::Runtime
                } else {
                    DiscoveryScope::Deployment
                },
                existed,
                planned_actions: change.change.actions.clone(),
                drifted,
                retained: retained.contains(&change.address),
                reuse_planned: existed && !drifted && change.change.actions == ["no-op"],
            });
        }
        report
            .resources
            .sort_by(|left, right| left.address.cmp(&right.address));
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inline_and_scoped_provider_sources_preserve_authored_names_without_values() {
        let mut input: Value =
            serde_saphyr::from_str(include_str!("../../tests/fixtures/config/local.yaml")).unwrap();
        let provider = input["spec"]["inferenceProviders"]["local"].take();
        input["spec"]
            .as_object_mut()
            .unwrap()
            .remove("inferenceProviders");
        let sandbox = &mut input["spec"]["sandboxes"]["assistant"];
        sandbox["inferenceProviders"] = json!({"responses": provider});
        let route = &mut sandbox["agent"]["inference"]["routes"][0];
        route["providerRef"] = "responses".into();
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        let mut result = OperationResult::planned(Vec::new());
        result.describe_sources(&document).unwrap();
        assert_eq!(result.resource_sources.len(), 1);
        assert!(
            result
                .resource_sources
                .values()
                .all(|source| source.name == "responses"
                    && source.path == "spec.sandboxes[assistant].inferenceProviders[responses]")
        );
        let sandbox = &mut input["spec"]["sandboxes"]["assistant"];
        let mut provider = sandbox["inferenceProviders"]["responses"].take();
        sandbox
            .as_object_mut()
            .unwrap()
            .remove("inferenceProviders");
        provider["name"] = "anthro".into();
        provider["credential"] = json!({"env":"PRIVATE_REFERENCE"});
        provider["endpoint"] = "https://inference.example.test/v1".into();
        let route = &mut sandbox["agent"]["inference"]["routes"][0];
        route.as_object_mut().unwrap().remove("providerRef");
        route["provider"] = provider;
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        let mut result = OperationResult::planned(Vec::new());
        result.describe_sources(&document).unwrap();
        assert_eq!(result.resource_sources.len(), 1);
        assert!(
            result
                .resource_sources
                .values()
                .all(|source| source.name == "anthro"
                    && source.path
                        == "spec.sandboxes[assistant].agent.inference.routes[primary].provider")
        );
        assert!(
            !serde_json::to_string(&result.resource_sources)
                .unwrap()
                .contains("PRIVATE_REFERENCE")
        );
    }

    #[test]
    fn catalog_and_apply_time_readiness_do_not_defer_resource_planning() {
        let mut report: DiscoveryReport = serde_json::from_value(json!({"observations":{
            "endpoint_0":{"kind":"inference","observation":{"status":"unknown","reason":"catalog unsupported","source":"control_host_http_models","reachable":true,"authentication":"unknown","models":[],"api_verified":false}},
            "endpoint_1":{"kind":"unresolved","observation":{"category":"inference"}},
            "service_model":{"kind":"service","observation":{"ready":null,"source":"service_readiness"}},
            "service_stopped":{"kind":"service","observation":{"ready":false,"source":"service_readiness"}}
        }})).unwrap();
        assert!(report.deferred().is_empty(), "{:?}", report.deferred());
        assert_eq!(report.unverified().len(), 4);
        report.observations.insert(
            "gateway".into(),
            ReportedObservation::Plan(PlanObservation::Unresolved {
                category: "gateway".into(),
            }),
        );
        assert_eq!(report.deferred().len(), 1);
        assert!(report.deferred()[0].contains("Gateway"));
        let encoded = serde_json::to_value(&report).unwrap();
        assert_eq!(
            encoded["observations"]["service_model"]["observation"]["ready"],
            Value::Null
        );
        assert_eq!(
            encoded["observations"]["service_stopped"]["observation"]["ready"],
            false
        );
        assert_eq!(
            encoded["observations"]["endpoint_0"]["observation"]["status"],
            "unknown"
        );
    }

    #[test]
    fn query_provenance_copies_only_safe_inputs_not_provider_payloads() {
        let plan:Plan=serde_json::from_value(json!({"planned_values":{"root_module":{"resources":[{"address":"data.host_engine.target_0","values":{"engine":"unix:///var/run/docker.sock","credential":"PRIVATE_SENTINEL","spec":"PRIVATE_SENTINEL","observation_json":null}}]}}})).unwrap();
        let report = plan
            .discovery_report(&BTreeSet::new(), &BTreeMap::new(), &BTreeSet::new())
            .unwrap();
        assert_eq!(
            report.targets["target_0"].engine.as_deref(),
            Some("unix:///var/run/docker.sock")
        );
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
    }
}

#[cfg(test)]
mod prerequisite_tests {
    use super::*;
    use crate::discovery::{EngineObservation, GatewayPrerequisitesObservation, ObservationStatus};

    fn reported(discovery: Value) -> DiscoveryReport {
        let plan: Plan = serde_json::from_value(
            json!({"planned_values":{"outputs":{"discovery":{"value":discovery}}}}),
        )
        .unwrap();
        plan.discovery_report(&BTreeSet::new(), &BTreeMap::new(), &BTreeSet::new())
            .unwrap()
    }

    fn facts() -> String {
        let mut engine = EngineObservation::unknown("");
        engine.status = ObservationStatus::Available;
        engine.reason = None;
        engine.architecture = Some("arm64".into());
        serde_json::to_string(&engine).unwrap()
    }

    fn prerequisites(status: ObservationStatus, reason: Option<&str>) -> String {
        serde_json::to_string(&GatewayPrerequisitesObservation {
            status,
            reason: reason.map(str::to_owned),
        })
        .unwrap()
    }

    fn engine(report: &DiscoveryReport) -> EngineObservation {
        match &report.observations["engine"] {
            ReportedObservation::Discovery(DiscoveryObservation::Engine(engine)) => engine.clone(),
            other => panic!("engine observation: {other:?}"),
        }
    }

    /// The engine's facts and a managed gateway's prerequisites are separate
    /// reads; the report states them as one engine observation, whose status
    /// is the less available of the two.
    #[test]
    fn unmet_gateway_prerequisites_make_the_engine_unavailable() {
        let reason = "Podman sandbox driver requires a Podman engine socket";
        let report = reported(json!({
            "engine": facts(),
            "gateway_prerequisites": prerequisites(ObservationStatus::Unavailable, Some(reason)),
        }));
        let engine = engine(&report);
        assert_eq!(engine.status, ObservationStatus::Unavailable);
        assert_eq!(engine.reason.as_deref(), Some(reason));
        assert_eq!(engine.architecture.as_deref(), Some("arm64"));
        assert!(!report.observations.contains_key("gateway_prerequisites"));
        let met = reported(json!({
            "engine": facts(),
            "gateway_prerequisites": prerequisites(ObservationStatus::Available, None),
        }));
        assert_eq!(engine_status(&met), ObservationStatus::Available);
    }

    fn engine_status(report: &DiscoveryReport) -> ObservationStatus {
        engine(report).status
    }

    /// Until its prerequisites are read, a managed gateway's engine is unverified.
    #[test]
    fn unread_gateway_prerequisites_leave_the_engine_unresolved() {
        let report = reported(json!({"engine": facts(), "gateway_prerequisites": null}));
        assert!(
            matches!(
                &report.observations["engine"],
                ReportedObservation::Plan(PlanObservation::Unresolved { category }) if category == "engine"
            ),
            "{:?}",
            report.observations
        );
        assert!(!report.observations.contains_key("gateway_prerequisites"));
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::*;
    use crate::discovery::EngineObservation;

    /// The CLI prints this report, so each kind keeps its tag and shape.
    #[test]
    fn every_observation_kind_keeps_its_report_encoding() {
        let expected = json!({"observations": {
            "engine": {"kind": "engine", "observation": serde_json::to_value(EngineObservation::unknown("unreachable")).unwrap()},
            "runtime_image_0": {"kind": "runtime_image", "observation": {"status": "available", "source": "engine_image_inspect"}},
            "service_model": {"kind": "service", "observation": {"ready": null, "source": "service_readiness"}},
            "gateway": {"kind": "unresolved", "observation": {"category": "gateway"}}
        }});
        let report: DiscoveryReport = serde_json::from_value(expected.clone()).unwrap();
        assert_eq!(serde_json::to_value(&report).unwrap(), expected);
    }
}
