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
            observed_running: matches!(
                kind,
                "managed_gateway"
                    | "agent_configuration"
                    | nemoclaw_sdk::kubernetes::GATEWAY_KIND
                    | nemoclaw_sdk::kubernetes::STORAGE_KIND
                    | nemoclaw_sdk::kubernetes::AUTH_KIND
                    | nemoclaw_sdk::kubernetes::services::SERVICE_KIND
                    | nemoclaw_sdk::kubernetes::services::STORAGE_KIND
            ),
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
    if definition.kind == nemoclaw_sdk::kubernetes::AUTH_KIND {
        proposed.insert(
            "release_present".into(),
            prior
                .get("release_present")
                .cloned()
                .unwrap_or(Value::Unknown),
        );
        let prepared = matches!(prior.get("running"), Some(Value::Value(value)) if value == "true");
        proposed.insert(
            "gateway_values".into(),
            prior
                .get("gateway_values")
                .filter(|_| prepared)
                .cloned()
                .unwrap_or(Value::Unknown),
        );
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
pub mod cluster_services;
mod discovery;
mod gateway;
pub mod hardware;
mod hardware_data;
mod inference_discovery;
pub mod kubernetes;
mod provider;
mod readiness;
mod runtime_image;
mod sandbox_readiness;
pub use provider::NemoClawProvider;

/// OpenShell resource operations owned by this provider.
pub mod openshell;

pub mod docker;
pub mod hardware_observation;
pub mod managed;
pub mod services;
pub(crate) use nemoclaw_sdk::{
    CancellationToken, Error, ObservationError, Progress, backend, config,
};

mod download;
pub(crate) use nemoclaw_sdk::{ByteProgress, DownloadPhase};

#[cfg(all(test, unix))]
use nemoclaw_sdk::compile;
