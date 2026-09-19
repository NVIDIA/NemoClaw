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
    pub change: PlannedChange,
}
fn gateway_observation(
    change: &ResourceChange,
    seen: &mut bool,
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
    if change.address != crate::compile::GATEWAY_CAPABILITIES_ADDRESS
        || std::mem::replace(seen, true)
        || !(change.change.actions == ["no-op"]
            || (!destroying && change.change.actions == ["read"])
            || (destroying && change.change.actions == ["delete"]))
    {
        return Err(Error::Conflict(
            "plan contains an unexpected gateway observation",
        ));
    }
    Ok(true)
}
#[derive(Deserialize)]
pub(super) struct PlannedChange {
    pub actions: Vec<String>,
    #[serde(default)]
    pub before: Value,
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
pub(super) fn check_plan(
    plan: &Plan,
    allowed: &BTreeMap<String, Row>,
    bindings: &BTreeMap<String, StateBinding>,
) -> Result<Vec<Change>, Error> {
    let mut seen = BTreeSet::new();
    let mut changes = Vec::new();
    let mut gateway_seen = false;
    for change in &plan.resource_changes {
        if gateway_observation(change, &mut gateway_seen, false)? {
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
    if seen.len() != allowed.len() {
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
    let mut gateway_seen = false;
    for drift in &plan.resource_drift {
        if gateway_observation(drift, &mut gateway_seen, true)? {
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
    let mut gateway_seen = false;
    for change in &plan.resource_changes {
        if gateway_observation(change, &mut gateway_seen, true)? {
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
        identity(change, expected, binding)?;
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
    if bindings
        .keys()
        .any(|key| !seen.contains(key) && !absent.contains(key))
    {
        return Err(Error::Conflict(
            "destroy plan omitted a resource without confirmed absence",
        ));
    }
    Ok(changes)
}
