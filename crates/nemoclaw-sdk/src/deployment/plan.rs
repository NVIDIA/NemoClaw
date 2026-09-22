// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
#[derive(Deserialize)]
pub(super) struct Plan {
    #[serde(default)]
    pub resource_changes: Vec<ResourceChange>,
    #[serde(default)]
    pub resource_drift: Vec<ResourceChange>,
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
    let expected = (change.address.starts_with("data.docker_image.")
        && allowed.contains_key(&change.address))
        || crate::compile::is_gateway_observation(&change.address)
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
    for key in ["name", "workspace", "owner", "generation", "spec"] {
        if let Some(value) = expected.get(key)
            && change.change.before[key] != *value
        {
            return Err(Error::Conflict(
                "plan ownership or configuration disagrees with retained intent",
            ));
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
