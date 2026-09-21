// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
#[derive(Deserialize, Default)]
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
pub(super) fn observation(
    change: &ResourceChange,
    seen: &mut BTreeSet<String>,
    allowed: &BTreeMap<String, Row>,
    gateway: bool,
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
        || (gateway && crate::compile::is_gateway_observation(&change.address))
        || allowed.keys().any(|address| {
            (address.starts_with("docker_container.inference_service_")
                || address.starts_with("docker_container.ollama_service_"))
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
pub(super) fn disposable(address: &str) -> bool {
    crate::docker_compute::is_disposable(address)
}

// OpenTofu may retain an old object after create-before-destroy replacement.
// It owns retrying that deletion; the SDK only verifies the recorded identity.
fn cleanup(
    change: &ResourceChange,
    bindings: &BTreeMap<String, StateBinding>,
    seen: &mut BTreeSet<(String, String)>,
) -> Result<Option<Change>, Error> {
    let Some(key) = &change.deposed else {
        return Ok(None);
    };
    let id = bindings
        .get(&change.address)
        .and_then(|binding| binding.deposed.get(key));
    let absent = change.change.actions == ["no-op"]
        && change.change.before.is_null()
        && change.change.after.is_null();
    if !disposable(&change.address)
        || change.address.starts_with("docker_volume.")
        || id.is_none()
        || (!absent
            && (id.is_some_and(|id| change.change.before["id"] != *id)
                || change.change.actions != ["delete"]))
        || !seen.insert((change.address.clone(), key.clone()))
    {
        return Err(Error::Conflict("plan contains invalid replacement cleanup"));
    }
    Ok(Some(Change {
        resource: format!("{} (deposed {key})", change.address),
        actions: change.change.actions.clone(),
    }))
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
        if observation(change, &mut observations, allowed, true, false)? {
            continue;
        }
        if let Some(cleanup) = cleanup(change, bindings, &mut cleanup_seen)? {
            if cleanup.actions != ["no-op"] {
                changes.push(cleanup);
            }
            continue;
        }
        if disposable(&change.address) {
            if (!allowed.contains_key(&change.address) && !bindings.contains_key(&change.address))
                || !seen.insert(&change.address)
                || !matches!(
                    change
                        .change
                        .actions
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
                || (!allowed.contains_key(&change.address) && change.change.actions != ["delete"])
            {
                return Err(Error::Conflict(
                    "plan contains invalid or undeclared disposable compute",
                ));
            }
            if change.change.actions != ["no-op"] {
                changes.push(Change {
                    resource: change.address.clone(),
                    actions: change.change.actions.clone(),
                });
            }
            continue;
        }
        let expected = allowed
            .get(&change.address)
            .ok_or(Error::Conflict("plan contains an undeclared resource"))?;
        if !seen.insert(&change.address)
            || change.change.actions.len() != 1
            || !["no-op", "create", "update"].contains(&change.change.actions[0].as_str())
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
    let mut cleanup_absent = BTreeSet::new();
    for drift in &plan.resource_drift {
        if observation(drift, &mut observations, allowed, true, true)? {
            continue;
        }
        if cleanup(drift, bindings, &mut cleanup_absent)?.is_some() {
            continue;
        }
        if !allowed.contains_key(&drift.address) {
            return Err(Error::Conflict(
                "destroy plan reports changes to an undeclared resource",
            ));
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
        if observation(change, &mut observations, allowed, true, true)? {
            continue;
        }
        if let Some(cleanup) = cleanup(change, bindings, &mut cleanup_seen)? {
            if cleanup_absent.contains(&(change.address.clone(), change.deposed.clone().unwrap())) {
                return Err(Error::Conflict(
                    "destroy plan duplicated replacement cleanup",
                ));
            }
            if cleanup.actions != ["no-op"] {
                changes.push(cleanup);
            }
            continue;
        }
        let expected = allowed.get(&change.address).ok_or(Error::Conflict(
            "destroy plan contains an undeclared resource",
        ))?;
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
        !binding.id.is_empty() && !seen.contains(key) && !absent.contains(key)
    }) {
        return Err(Error::Conflict(
            "destroy plan omitted a resource without confirmed absence",
        ));
    }
    Ok(changes)
}
