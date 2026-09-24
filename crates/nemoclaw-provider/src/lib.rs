// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OpenTofu protocol adapter for shared desired-state operations.

use std::collections::BTreeMap;
use tf_provider::value::Value;

/// OpenTofu string attributes, including distinct null and unknown values.
pub type State = BTreeMap<String, Value<String>>;

/// Stable resource schema and the fields permitted to change in place.
#[derive(Clone, Debug)]
pub struct Definition {
    pub kind: &'static str,
    pub fields: Vec<&'static str>,
    pub mutable: Vec<&'static str>,
    pub observed_running: bool,
}

impl Definition {
    pub fn new(kind: &'static str, fields: &[&'static str], mutable: &[&'static str]) -> Self {
        Self {
            kind,
            fields: fields.to_vec(),
            mutable: mutable.to_vec(),
            observed_running: matches!(kind, "managed_gateway" | "pi_configuration"),
        }
    }
}

/// Preserve established computed identity; mark immutable configuration changes
/// for replacement. The resource adapter protects retained and stateful resources.
pub fn plan_update(
    definition: &Definition,
    prior: &State,
    mut proposed: State,
) -> (State, Vec<&'static str>) {
    if matches!(
        proposed.get("id"),
        Some(Value::Unknown | Value::Null) | None
    ) && let Some(id) = prior.get("id")
    {
        proposed.insert("id".into(), id.clone());
    }
    if definition.kind == "gateway_storage" {
        proposed.insert(
            "data_path".into(),
            prior.get("data_path").cloned().unwrap_or(Value::Unknown),
        );
    }
    if definition.observed_running {
        match prior.get("running") {
            Some(Value::Value(value)) if value == "false" => {
                proposed.insert("running".into(), Value::Unknown);
            }
            Some(value) => {
                proposed.insert("running".into(), value.clone());
            }
            None => {}
        }
    }
    let authentication_changed = definition.kind == "provider"
        && authentication_mode(prior) != authentication_mode(&proposed);
    let replacements = definition
        .fields
        .iter()
        .copied()
        .filter(|field| {
            (!definition.mutable.contains(field)
                || (*field == "credential_env" && authentication_changed))
                && proposed.get(*field) != prior.get(*field)
        })
        .collect();
    (proposed, replacements)
}

fn authentication_mode(state: &State) -> Option<bool> {
    let mut authenticated = false;
    for field in ["credential_env", "credential_source"] {
        match state.get(field) {
            Some(Value::Unknown) => return None,
            Some(Value::Value(value)) => authenticated |= !value.is_empty(),
            Some(Value::Null) | None => {}
        }
    }
    Some(authenticated)
}

mod resource;
pub use nemoclaw_sdk::backend::{Backend, Mutation, Row};
pub use resource::ResourceAdapter;
mod capacity;
mod discovery;
mod gateway;
mod hardware;
mod inference_discovery;
mod provider;
mod readiness;
mod sandbox_readiness;
pub use provider::NemoClawProvider;
