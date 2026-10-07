// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
#[derive(Deserialize)]
pub(super) struct Plan {
    #[serde(default)]
    pub resource_changes: Vec<ResourceChange>,
    #[serde(default)]
    pub resource_drift: Vec<ResourceChange>,
    #[serde(default)]
    pub planned_values: Value,
}
#[derive(Deserialize)]
pub(super) struct ResourceChange {
    #[serde(default)]
    pub mode: Option<String>,
    pub address: String,
    #[serde(default)]
    pub deposed: Option<String>,
    pub change: PlannedChange,
}
fn observation(
    change: &ResourceChange,
    seen: &mut BTreeSet<String>,
    allowed: &BTreeMap<String, Row>,
    destroying: bool,
) -> Result<bool, Error> {
    if change.mode.as_deref() != Some("data") {
        if change.mode.as_deref().is_some_and(|mode| mode != "managed") {
            return Err(Error::Conflict(
                "plan contains an unsupported resource mode",
            ));
        }
        return Ok(false);
    }
    let runtime_image = ["runtime_image_present_", "runtime_image_acquired_"]
        .iter()
        .any(|prefix| {
            change
                .address
                .strip_prefix(&format!("data.nemoclaw_runtime_image.{prefix}"))
                .is_some_and(|name| allowed.contains_key(&format!("docker_container.{name}")))
        });
    let expected = runtime_image
        || (change.address.starts_with("data.docker_image.")
            && allowed.contains_key(&change.address))
        || crate::compile::is_gateway_observation(&change.address)
        || crate::discovery_graph::is_observation(&change.address)
        || allowed.keys().any(|address| {
            address
                .strip_prefix("nemoclaw_sandbox.")
                .is_some_and(|name| {
                    change.address == format!("data.nemoclaw_sandbox_readiness.{name}")
                })
        })
        || allowed.keys().any(|address| {
            (address.starts_with("docker_container.inference_service_")
                || address.starts_with("docker_container.ollama_service_")
                || address.starts_with("docker_container.ollama_proxy_"))
                && change.address
                    == format!(
                        "data.nemoclaw_service_readiness.{}",
                        address.split_once('.').unwrap().1
                    )
        })
        || crate::services::capacity::groups(
            allowed.iter().map(|(address, row)| (address.as_str(), row)),
        )?
        .keys()
        .any(|engine| change.address == crate::services::capacity::observation_address(engine));
    if change.deposed.is_some()
        || !expected
        || !seen.insert(change.address.clone())
        || !(change.change.actions == ["no-op"]
            || (!destroying && change.change.actions == ["read"])
            || (destroying && change.change.actions == ["delete"]))
    {
        return Err(Error::Conflict("plan contains an unexpected observation"));
    }
    Ok(true)
}
#[derive(Deserialize)]
pub(super) struct PlannedChange {
    pub actions: Vec<String>,
    #[serde(default)]
    pub before: Value,
    #[serde(default)]
    pub after: Value,
}
fn identity(change: &ResourceChange, expected: &Row, binding: &StateBinding) -> Result<(), Error> {
    if change.change.before["id"] != binding.id {
        return Err(Error::Conflict("plan changed a durable resource identity"));
    }
    for key in [
        "name",
        "namespace",
        "chart",
        "workspace",
        "owner",
        "generation",
        "spec",
    ] {
        if let Some(value) = expected.get(key)
            && change.change.before[key] != *value
        {
            return Err(Error::Conflict(
                "plan ownership or configuration disagrees with retained intent",
            ));
        }
    }
    if change.address == crate::kubernetes::gateway::ADDRESS && !change.change.after.is_null() {
        for key in ["name", "namespace", "chart"] {
            if let Some(value) = expected.get(key)
                && change.change.after[key] != *value
            {
                return Err(Error::Conflict(
                    "plan would change the retained Helm release identity",
                ));
            }
        }
    }
    Ok(())
}
pub(super) use crate::docker_compute::is_disposable as disposable;

pub(super) fn reconstructible(address: &str) -> bool {
    address.split_once('.').is_some_and(|(kind, _)| {
        crate::backend::openshell_lifecycle(kind)
            == Some(crate::backend::OpenShellLifecycle::Reconstructible)
    })
}

fn standard_actions(actions: &[String]) -> bool {
    matches!(
        actions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice(),
        ["no-op"]
            | ["create"]
            | ["update"]
            | ["delete"]
            | ["delete", "create"]
            | ["create", "delete"]
    )
}

pub(super) fn check_plan(
    plan: &Plan,
    allowed: &BTreeMap<String, Row>,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<Vec<Change>, Error> {
    let mut seen = BTreeSet::new();
    let mut changes = Vec::new();
    let mut observations = BTreeSet::new();
    let mut cleanup_seen = BTreeSet::new();
    for change in &plan.resource_changes {
        if observation(change, &mut observations, allowed, false)? {
            continue;
        }
        if reconstructible(&change.address) || disposable(&change.address) {
            // OpenTofu state and provider refresh own physical identities,
            // absence and replacement cleanup. The SDK only checks graph scope.
            if !allowed.contains_key(&change.address) && !bindings.contains_key(&change.address) {
                return Err(Error::Conflict("plan contains an undeclared resource"));
            }
            let resource = if let Some(key) = &change.deposed {
                if change.address.starts_with("docker_volume.")
                    || !cleanup_seen.insert((change.address.clone(), key.clone()))
                {
                    return Err(Error::Conflict("plan contains invalid replacement cleanup"));
                }
                format!("{} (deposed {key})", change.address)
            } else {
                if !seen.insert(&change.address) {
                    return Err(Error::Conflict("plan contains a duplicate resource"));
                }
                change.address.clone()
            };
            if !standard_actions(&change.change.actions) {
                return Err(Error::Conflict(
                    "plan contains unsupported resource actions",
                ));
            }
            if change.change.actions != ["no-op"] {
                changes.push(Change {
                    resource,
                    actions: change.change.actions.clone(),
                });
            }
            continue;
        }
        if change.deposed.is_some() {
            return Err(Error::Conflict("plan contains invalid replacement cleanup"));
        }
        let expected = allowed
            .get(&change.address)
            .ok_or(Error::Conflict("plan contains an undeclared resource"))?;
        let replacement = change.change.actions == ["delete", "create"]
            && change.address.starts_with("nemoclaw_managed_gateway.")
            && bindings.contains_key(&change.address);
        if !seen.insert(&change.address)
            || (!replacement
                && (change.change.actions.len() != 1
                    || !["no-op", "create", "update"].contains(&change.change.actions[0].as_str())))
        {
            return Err(Error::Conflict(
                "plan would remove, replace, or duplicate a resource",
            ));
        }
        if let Some(binding) = bindings.get(&change.address) {
            if change.change.actions[0] == "create" {
                return Err(Error::Conflict(
                    "plan would recreate an established resource",
                ));
            }
            identity(change, expected, binding)?;
        }
        if change.change.actions[0] != "no-op" {
            changes.push(Change {
                resource: change.address.clone(),
                actions: change.change.actions.clone(),
            });
        }
    }
    if allowed
        .keys()
        .filter(|address| !address.starts_with("data."))
        .any(|address| !seen.contains(address))
    {
        return Err(Error::Conflict("plan omitted a required resource"));
    }
    Ok(changes)
}
pub(super) fn check_destroy_plan(
    plan: &Plan,
    allowed: &BTreeMap<String, Row>,
    bindings: &BTreeMap<String, StateBinding>,
    retained: &BTreeSet<String>,
) -> Result<Vec<Change>, Error> {
    let mut absent = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut changes = Vec::new();
    let mut observations = BTreeSet::new();
    let delegated = |address: &str| {
        !retained.contains(address) && (reconstructible(address) || disposable(address))
    };
    for drift in &plan.resource_drift {
        if observation(drift, &mut observations, allowed, true)? {
            continue;
        }
        if !allowed.contains_key(&drift.address) {
            return Err(Error::Conflict(
                "destroy plan reports changes to an undeclared resource",
            ));
        }
        // OpenTofu refresh owns absence and old replacement objects for these
        // resources. Retained data and durable identities still require proof.
        if delegated(&drift.address) {
            continue;
        }
        if drift.deposed.is_some() {
            return Err(Error::Conflict("plan contains invalid replacement cleanup"));
        }
        if !bindings.contains_key(&drift.address) {
            return Err(Error::Conflict(
                "destroy plan reports changes to a resource without a saved ID",
            ));
        }
        if drift.address == crate::kubernetes::gateway::ADDRESS
            && drift.change.actions == ["delete"]
        {
            // Helm IDs contain only the release name, so namespace and chart
            // must also match before absence can settle partial teardown.
            identity(drift, &allowed[&drift.address], &bindings[&drift.address])?;
            // The Helm provider can report absence after a release lookup
            // failure. Require the authentication resource's independent
            // Secret-metadata observation before retiring this binding.
            let auth_address = "nemoclaw_kubernetes_auth.runtime";
            let confirmed = plan.resource_changes.iter().any(|change| {
                change.address == auth_address
                    && change.mode.as_deref() == Some("managed")
                    && change.deposed.is_none()
                    && change.change.actions == ["delete"]
                    && change.change.before["release_present"] == "false"
                    && bindings.get(auth_address).is_some_and(|binding| {
                        !binding.id.is_empty() && change.change.before["id"] == binding.id
                    })
            });
            if !confirmed {
                return Err(Error::Conflict(
                    "Helm release absence requires an independent Kubernetes observation; state retained",
                ));
            }
        }
        if drift.change.actions == ["delete"]
            && (!absent.insert(&drift.address)
                || retained.contains(&drift.address)
                || drift.change.before["id"] != bindings[&drift.address].id)
        {
            return Err(Error::Conflict(
                "destroy plan lost a retained or differently bound resource",
            ));
        }
    }
    let mut observations = BTreeSet::new();
    let mut cleanup_seen = BTreeSet::new();
    for change in &plan.resource_changes {
        if observation(change, &mut observations, allowed, true)? {
            continue;
        }
        let expected = allowed.get(&change.address).ok_or(Error::Conflict(
            "destroy plan contains an undeclared resource",
        ))?;
        if delegated(&change.address) {
            let resource = if let Some(key) = &change.deposed {
                if change.address.starts_with("docker_volume.")
                    || !cleanup_seen.insert((change.address.clone(), key.clone()))
                {
                    return Err(Error::Conflict("plan contains invalid replacement cleanup"));
                }
                format!("{} (deposed {key})", change.address)
            } else {
                if !seen.insert(&change.address) {
                    return Err(Error::Conflict(
                        "destroy plan contains a duplicate resource",
                    ));
                }
                change.address.clone()
            };
            let absent = change.change.actions == ["no-op"]
                && change.change.before.is_null()
                && change.change.after.is_null();
            if change.change.actions != ["delete"] && !absent {
                return Err(Error::Conflict(
                    "destroy plan would create, update, replace, forget, or delete retained data",
                ));
            }
            if !absent {
                changes.push(Change {
                    resource,
                    actions: change.change.actions.clone(),
                });
            }
            continue;
        }
        if change.deposed.is_some() {
            return Err(Error::Conflict("plan contains invalid replacement cleanup"));
        }
        let binding = bindings.get(&change.address).ok_or(Error::Conflict(
            "destroy plan contains a resource without a saved ID",
        ))?;
        if !seen.insert(&change.address) || absent.contains(&change.address) {
            return Err(Error::Conflict(
                "destroy plan contains a duplicate resource",
            ));
        }
        if !disposable(&change.address) {
            identity(change, expected, binding)?;
        }
        let action = if retained.contains(&change.address) {
            "no-op"
        } else {
            "delete"
        };
        if change.change.actions != [action] {
            return Err(Error::Conflict(
                "destroy plan would create, update, replace, forget, or delete retained data",
            ));
        }
        if action == "delete" {
            changes.push(Change {
                resource: change.address.clone(),
                actions: change.change.actions.clone(),
            });
        }
    }
    if bindings.iter().any(|(key, binding)| {
        !delegated(key) && !binding.id.is_empty() && !seen.contains(key) && !absent.contains(key)
    }) {
        return Err(Error::Conflict(
            "destroy plan omitted a resource without confirmed absence",
        ));
    }
    Ok(changes)
}

impl Plan {
    /// Prerequisites `report`, this plan's discovery, leaves unresolved. A
    /// discovery output OpenTofu cannot compute yet has no reads to classify.
    pub(super) fn discovery_deferred(&self, report: &DiscoveryReport) -> Vec<String> {
        let mut deferred = report.deferred();
        if report.observations.is_empty()
            && self.planned_values.pointer("/outputs/discovery").is_some()
            && self
                .planned_values
                .pointer("/outputs/discovery/value")
                .is_none()
        {
            deferred.push(
                "Target discovery remains unknown until its provider inputs can be resolved."
                    .into(),
            );
        }
        deferred
    }
}

#[cfg(test)]
mod native_helm_tests {
    use super::*;

    const ADDRESS: &str = "helm_release.gateway";

    fn saved() -> (BTreeMap<String, Row>, BTreeMap<String, StateBinding>, Value) {
        let values = json!({
            "id": "nc-owned", "name": "nc-owned", "namespace": "owned-agents",
            "chart": crate::kubernetes::gateway::CHART
        });
        let expected = [
            ("name".into(), "nc-owned".into()),
            ("namespace".into(), "owned-agents".into()),
            ("chart".into(), crate::kubernetes::gateway::CHART.into()),
        ]
        .into();
        (
            [(ADDRESS.into(), expected)].into(),
            [(
                ADDRESS.into(),
                serde_json::from_value(values.clone()).unwrap(),
            )]
            .into(),
            values,
        )
    }

    fn planned(actions: &[&str], before: Value, after: Value) -> Plan {
        serde_json::from_value(json!({"resource_changes":[{
            "mode":"managed", "address":ADDRESS,
            "change":{"actions":actions, "before":before, "after":after}
        }]}))
        .unwrap()
    }

    #[test]
    fn a_bound_helm_release_cannot_be_replaced_recreated_or_removed_during_apply() {
        let (allowed, bindings, values) = saved();
        assert!(!disposable(ADDRESS));
        assert!(!reconstructible(ADDRESS));
        for actions in [
            vec!["delete"],
            vec!["create"],
            vec!["delete", "create"],
            vec!["create", "delete"],
            vec!["forget"],
        ] {
            let plan = planned(&actions, values.clone(), values.clone());
            assert!(
                check_plan(&plan, &allowed, &bindings).is_err(),
                "{actions:?}"
            );
        }
        let create = planned(&["create"], Value::Null, values.clone());
        assert!(check_plan(&create, &allowed, &BTreeMap::new()).is_ok());
        let unchanged = planned(&["no-op"], values.clone(), values);
        assert!(
            check_plan(&unchanged, &allowed, &bindings)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_helm_plan_rejects_namespace_or_chart_drift_before_apply_or_destroy() {
        let (allowed, bindings, values) = saved();
        for field in ["id", "name", "namespace", "chart"] {
            let mut changed = values.clone();
            changed[field] = json!("substituted");
            let update = planned(&["update"], changed.clone(), values.clone());
            assert!(check_plan(&update, &allowed, &bindings).is_err(), "{field}");
            let delete = planned(&["delete"], changed, Value::Null);
            assert!(
                check_destroy_plan(&delete, &allowed, &bindings, &BTreeSet::new()).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn a_helm_update_cannot_change_the_retained_release_identity() {
        let (allowed, bindings, values) = saved();
        for field in ["name", "namespace", "chart"] {
            let mut after = values.clone();
            after[field] = json!("substituted");
            let plan = planned(&["update"], values.clone(), after);
            assert!(check_plan(&plan, &allowed, &bindings).is_err(), "{field}");
        }
    }

    #[test]
    fn partial_helm_destroy_requires_confirmed_absence_of_the_saved_release() {
        let (mut allowed, mut bindings, values) = saved();
        let delete = planned(&["delete"], values.clone(), Value::Null);
        assert_eq!(
            check_destroy_plan(&delete, &allowed, &bindings, &BTreeSet::new())
                .unwrap()
                .len(),
            1
        );
        let auth_address = "nemoclaw_kubernetes_auth.runtime";
        let auth = json!({"id":"auth-uid", "spec":"retained-auth-spec"});
        allowed.insert(
            auth_address.into(),
            [("spec".into(), "retained-auth-spec".into())].into(),
        );
        bindings.insert(
            auth_address.into(),
            serde_json::from_value(auth.clone()).unwrap(),
        );
        let absent = |before: Value, release_present: Value| -> Plan {
            let mut before_auth = auth.clone();
            before_auth["release_present"] = release_present;
            serde_json::from_value(json!({"resource_drift":[{
                "mode":"managed", "address":ADDRESS,
                "change":{"actions":["delete"], "before":before, "after":null}
            }], "resource_changes":[{
                "mode":"managed", "address":auth_address,
                "change":{"actions":["delete"], "before":before_auth, "after":null}
            }]}))
            .unwrap()
        };
        assert_eq!(
            check_destroy_plan(
                &absent(values.clone(), json!("false")),
                &allowed,
                &bindings,
                &BTreeSet::new()
            )
            .unwrap()
            .len(),
            1,
            "only the separately owned authentication resource remains to delete",
        );
        for release_present in [json!("true"), Value::Null, json!("unknown"), json!(false)] {
            assert!(
                check_destroy_plan(
                    &absent(values.clone(), release_present),
                    &allowed,
                    &bindings,
                    &BTreeSet::new()
                )
                .is_err(),
                "native Helm absence requires the authentication resource's confirmed string false",
            );
        }
        let absent_without_auth: Plan = serde_json::from_value(json!({"resource_drift":[{
            "mode":"managed", "address":ADDRESS,
            "change":{"actions":["delete"], "before":values, "after":null}
        }]}))
        .unwrap();
        assert!(
            check_destroy_plan(&absent_without_auth, &allowed, &bindings, &BTreeSet::new())
                .is_err()
        );
        let empty: Plan = serde_json::from_value(json!({})).unwrap();
        assert!(check_destroy_plan(&empty, &allowed, &bindings, &BTreeSet::new()).is_err());
        for field in ["id", "namespace", "chart"] {
            let mut changed = values.clone();
            changed[field] = json!("substituted");
            assert!(
                check_destroy_plan(
                    &absent(changed, json!("false")),
                    &allowed,
                    &bindings,
                    &BTreeSet::new()
                )
                .is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn a_null_helm_noop_cannot_discard_a_saved_release_binding() {
        let (allowed, bindings, _) = saved();
        let lost = planned(&["no-op"], Value::Null, Value::Null);
        assert!(check_destroy_plan(&lost, &allowed, &bindings, &BTreeSet::new()).is_err());
    }
}

#[cfg(test)]
pub(super) mod discovery_tests {
    use super::*;
    use crate::discovery::{
        EngineObservation, FabricObservation, GatewayObservation, ObservationStatus,
    };

    /// The deferrals a plan reports, as `plan` and `apply` compute them.
    pub(in crate::deployment) fn deferred(plan: &Plan) -> Vec<String> {
        let report = plan
            .discovery_report(
                DiscoveryScope::Deployment,
                &BTreeMap::new(),
                &BTreeSet::new(),
            )
            .unwrap();
        plan.discovery_deferred(&report)
    }

    pub(in crate::deployment) fn encoded(observation: impl serde::Serialize) -> String {
        serde_json::to_string(&observation).unwrap()
    }

    pub(in crate::deployment) fn available_engine() -> EngineObservation {
        EngineObservation {
            status: ObservationStatus::Available,
            ..EngineObservation::unknown("")
        }
    }

    pub(in crate::deployment) fn gateway(compatible: bool) -> GatewayObservation {
        GatewayObservation {
            status: ObservationStatus::Available,
            compatible: Some(compatible),
            ..GatewayObservation::unknown("")
        }
    }

    #[test]
    fn an_unknown_discovery_output_cannot_make_the_plan_complete() {
        let plan: Plan = serde_json::from_value(json!({
            "planned_values": {"outputs": {"discovery": {"sensitive": false}}}
        }))
        .unwrap();
        assert!(!deferred(&plan).is_empty());
    }

    #[test]
    fn unknown_and_absent_image_evidence_remain_unresolved_without_exposing_raw_diagnostics() {
        let absent = FabricObservation {
            status: ObservationStatus::Unavailable,
            ..FabricObservation::unknown("")
        };
        let plan: Plan = serde_json::from_value(json!({
            "planned_values": {"outputs": {"discovery": {"value": {
                "engine": encoded(available_engine()),
                "sandbox_0": encoded(FabricObservation::unknown("secret-sentinel")),
                "sandbox_1": encoded(absent)
            }}}}
        }))
        .unwrap();
        let deferred = deferred(&plan);
        assert_eq!(deferred.len(), 2);
        assert!(deferred.iter().all(|message| message.contains("Fabric")));
        assert!(!format!("{deferred:?}").contains("secret-sentinel"));
    }
}

#[cfg(test)]
mod reporting_tests {
    use super::*;
    #[test]
    fn inventory_reports_validated_actions_and_retention_without_copying_private_state() {
        let plan:Plan=serde_json::from_value(json!({"resource_changes":[{"mode":"managed","address":"nemoclaw_gateway_storage.runtime","change":{"actions":["no-op"],"before":{"id":"PRIVATE_SENTINEL","spec":"PRIVATE_SENTINEL"},"after":{"id":"PRIVATE_SENTINEL"}}}],"resource_drift":[{"mode":"managed","address":"nemoclaw_gateway_storage.runtime","change":{"actions":["update"],"before":{},"after":{}}}]})).unwrap();
        let report = plan
            .discovery_report(
                super::super::DiscoveryScope::Runtime,
                &BTreeMap::new(),
                &BTreeSet::from(["nemoclaw_gateway_storage.runtime".into()]),
            )
            .unwrap();
        assert_eq!(report.resources.len(), 1);
        assert!(report.resources[0].existed);
        assert!(report.resources[0].drifted);
        assert!(report.resources[0].retained);
        assert!(!report.resources[0].reuse_planned);
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("PRIVATE_SENTINEL")
        );
    }
    #[test]
    fn unknown_gateway_preserves_hardware_deferrals_without_blocking_on_catalogs() {
        use super::discovery_tests::{deferred, encoded};
        let catalog = encoded(crate::inference_discovery::EndpointObservation::unknown(""));
        let hardware = encoded(crate::hardware_discovery::HardwareObservation::unknown());
        let plan:Plan=serde_json::from_value(json!({"planned_values":{"outputs":{"discovery":{"sensitive":false}},"root_module":{"resources":[{"address":"data.nemoclaw_inference_capabilities.endpoint_0","values":{"observation_json":catalog}},{"address":"data.nemoclaw_target_hardware.target_0","values":{"observation_json":hardware}},{"address":"data.nemoclaw_gateway_capabilities.current","values":{"observation_json":null}}]}}})).unwrap();
        let messages = deferred(&plan);
        assert!(!messages.iter().any(|message| message.contains("Inference")));
        assert!(messages.iter().any(|message| message.contains("hardware")));
        assert!(messages.iter().any(|message| message.contains("Gateway")));
    }
}

#[cfg(test)]
mod nested_discovery_tests {
    use super::*;
    #[test]
    fn a_readable_image_is_not_a_verified_fabric_configuration() {
        use super::discovery_tests::{deferred, encoded, gateway};
        use crate::fabric_capabilities::{CompatibilityReport, Support};
        let readable = crate::discovery::FabricObservation {
            status: crate::discovery::ObservationStatus::Available,
            compatibility: Some(CompatibilityReport {
                status: Support::Unknown,
                adapter_id: None,
                checks: Vec::new(),
            }),
            ..crate::discovery::FabricObservation::unknown("")
        };
        let plan:Plan=serde_json::from_value(json!({"planned_values":{"outputs":{"discovery":{"value":{"sandbox_0":encoded(readable),"gateway":encoded(gateway(false))}}}}})).unwrap();
        let deferred = deferred(&plan);
        assert_eq!(deferred.len(), 2);
        assert!(deferred.iter().any(|message| message.contains("Fabric")));
        assert!(deferred.iter().any(|message| message.contains("Gateway")));
    }
}
