// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;

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
    pub drifted: bool,
    /// The owner's teardown compiler retains this established resource.
    pub retained: bool,
    /// An established resource has an unchanged plan and no reported drift.
    pub reuse_planned: bool,
}
pub use crate::discovery::DiscoveryObservation;
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
    pub observations: BTreeMap<String, DiscoveryObservation>,
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
    /// Unresolved facts after merging the latest observation for each query.
    pub fn deferred(&self) -> Vec<String> {
        self.observations
            .iter()
            .filter_map(|(name, observation)| {
                use crate::discovery::ObservationStatus::Available;
                let resolved = match observation {
                    DiscoveryObservation::Engine(value) => value.status == Available,
                    DiscoveryObservation::Hardware(value) => value.status == Available,
                    DiscoveryObservation::Inference(value) => value.status == Available,
                    DiscoveryObservation::Gateway(value) => {
                        value.status == Available && value.compatible == Some(true)
                    }
                    DiscoveryObservation::Fabric(value) => {
                        value.status == Available
                            && value.compatibility.as_ref().is_some_and(|compatibility| {
                                compatibility.status
                                    == crate::fabric_capabilities::Support::Supported
                            })
                    }
                    DiscoveryObservation::Service { ready, .. } => *ready == Some(true),
                    DiscoveryObservation::Unresolved { .. } => false,
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
    pub(super) fn extend(&mut self, other: Self) {
        self.targets.extend(other.targets);
        self.observations.extend(other.observations);
        self.resources.extend(other.resources);
        self.credentials.extend(other.credentials);
    }
}
fn observation_name(address: &str) -> Option<String> {
    if address == "data.nemoclaw_engine_capabilities.current" {
        Some("engine".into())
    } else if address == "data.nemoclaw_gateway_capabilities.current" {
        Some("gateway".into())
    } else {
        [
            "data.nemoclaw_fabric_capabilities.",
            "data.nemoclaw_target_hardware.",
            "data.nemoclaw_inference_capabilities.",
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
        "hardware"=>"Target hardware inventory remains unverified; requirements are still checked by the owning runtime.",
        "inference"=>"Inference endpoint catalog remains unverified from the control host; sandbox connectivity and generation APIs require their own checks.",
        "service"=>"Managed inference readiness remains unverified until the existing service observation completes.",
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
                if let Some(name) = observation_name(address) {
                    result
                        .entry(name)
                        .or_insert_with(|| resource["values"]["observation_json"].clone());
                } else if let Some(name) = address.strip_prefix("data.nemoclaw_service_readiness.")
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
                && let Some(name) = observation_name(&change.address)
            {
                result
                    .entry(name)
                    .or_insert_with(|| change.change.after["observation_json"].clone());
            }
        }
        result
    }
    /// Called only after the existing ownership, drift and transition checks pass.
    pub(super) fn discovery_report(
        &self,
        scope: DiscoveryScope,
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
                DiscoveryObservation::Service {
                    ready: value["ready"].as_bool(),
                    source: "service_readiness".into(),
                }
            } else if let Some(encoded) = value.as_str() {
                let invalid = |_| Error::State("invalid typed provider discovery observation");
                match category(&name) {
                    "engine" => DiscoveryObservation::Engine(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    ),
                    "gateway" => DiscoveryObservation::Gateway(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    ),
                    "hardware" => DiscoveryObservation::Hardware(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    ),
                    "inference" => DiscoveryObservation::Inference(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    ),
                    _ => DiscoveryObservation::Fabric(
                        serde_json::from_str(encoded).map_err(invalid)?,
                    ),
                }
            } else {
                DiscoveryObservation::Unresolved {
                    category: category(&name).into(),
                }
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
                scope,
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
    fn query_provenance_copies_only_safe_inputs_not_provider_payloads() {
        let plan:Plan=serde_json::from_value(json!({"planned_values":{"root_module":{"resources":[{"address":"data.nemoclaw_inference_capabilities.endpoint_0","values":{"endpoint":"https://example.com/v1","api":"openai-completions","credential_env":"API_KEY","credential":"PRIVATE_SENTINEL","spec":"PRIVATE_SENTINEL","observation_json":null}}]}}})).unwrap();
        let report = plan
            .discovery_report(
                DiscoveryScope::Deployment,
                &BTreeMap::new(),
                &BTreeSet::new(),
            )
            .unwrap();
        assert_eq!(
            report.targets["endpoint_0"].endpoint.as_deref(),
            Some("https://example.com/v1")
        );
        assert_eq!(
            report.targets["endpoint_0"].credential_env.as_deref(),
            Some("API_KEY")
        );
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
    }
}

#[cfg(test)]
mod freshness_tests {
    use super::*;
    #[test]
    fn newer_observation_replaces_an_earlier_unverified_fact_and_its_deferral() {
        let mut earlier = DiscoveryReport::default();
        earlier.observations.insert(
            "gateway".into(),
            DiscoveryObservation::Unresolved {
                category: "gateway".into(),
            },
        );
        assert_eq!(earlier.deferred().len(), 1);
        let mut later = DiscoveryReport::default();
        later.observations.insert(
            "gateway".into(),
            DiscoveryObservation::Gateway(crate::openshell::GatewayObservation {
                status: crate::discovery::ObservationStatus::Available,
                reason: None,
                source: "openshell_gateway_info".into(),
                capabilities: None,
                compatible: Some(true),
            }),
        );
        earlier.extend(later);
        assert!(earlier.deferred().is_empty());
    }
}
