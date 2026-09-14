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
}

impl Definition {
    pub fn new(kind: &'static str, fields: &[&'static str], mutable: &[&'static str]) -> Self {
        Self {
            kind,
            fields: fields.to_vec(),
            mutable: mutable.to_vec(),
        }
    }
}

/// Preserve established computed identity; mark immutable configuration changes
/// for replacement so the SDK can reject them before executing a saved plan.
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
    if matches!(definition.kind, "managed_gateway" | "inference_service") {
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
    let replacements = definition
        .fields
        .iter()
        .copied()
        .filter(|field| {
            !definition.mutable.contains(field) && proposed.get(*field) != prior.get(*field)
        })
        .collect();
    (proposed, replacements)
}

mod resource;
pub use nemoclaw_sdk::backend::{Backend, Mutation, Row};
pub use resource::ResourceAdapter;
mod provider;
pub use provider::NemoClawProvider;
