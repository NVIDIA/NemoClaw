// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! OpenTofu resource adapter: definitions, planning rules, and the
//! resource protocol over a backend.

use std::collections::BTreeMap;
use tf_provider::value::Value;

/// OpenTofu string attributes, including distinct null and unknown values.
pub type State = BTreeMap<String, Value<String>>;

/// Plans a computed attribute's update value from prior state; `None` keeps the proposal.
pub type PlanComputed = fn(name: &str, prior: &State) -> Option<Value<String>>;

/// Whether a change to a mutable field still requires replacement.
pub type Replaces = fn(field: &str, prior: &State, proposed: &State) -> bool;

/// Validates an encoded `spec` input for a resource kind.
pub type ValidateSpec = fn(kind: &str, encoded: &str) -> Result<(), nemoclaw_backend::Error>;

/// Checks one known input attribute, explaining a rejection without echoing the value.
pub type ValidateAttribute = fn(attribute: &str, value: &str) -> Result<(), &'static str>;

/// Generates a value for an omitted identity attribute when a resource is created.
pub type Generate = fn() -> Result<String, nemoclaw_backend::Error>;

/// Adds resource context to a diagnostic from the resource's known attributes.
pub type Describe = fn(error: String, attributes: &Row) -> String;

/// Whether an absent observation or a planned deletion would lose a binding
/// that must be retained.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Protection {
    #[default]
    None,
    Always,
    /// Explicit teardown may delete the resource.
    UnlessDestroying,
}

/// Stable resource schema, the fields permitted to change in place, and the
/// rules that govern its planning and observation.
#[derive(Clone, Debug)]
pub struct Definition {
    pub kind: &'static str,
    pub fields: Vec<&'static str>,
    pub mutable: Vec<&'static str>,
    /// Inputs that may be omitted; omission on create selects the empty default.
    pub optional: Vec<&'static str>,
    /// Optional inputs whose omission on update selects the empty default
    /// instead of carrying the prior value forward.
    pub reset_when_omitted: Vec<&'static str>,
    /// Inputs whose observations must preserve the recorded value, including
    /// the empty default of an omitted optional input.
    pub bound_fields: Vec<&'static str>,
    /// Attributes the backend observes, with their update planning rule.
    pub computed: Vec<(&'static str, PlanComputed)>,
    /// Optional inputs the provider generates on create when omitted, then
    /// keeps in state.
    pub generated: Vec<(&'static str, Generate)>,
    pub protection: Protection,
    /// Refuse replacement because it would discard retained identity or files.
    pub refuse_replacement: bool,
    /// During teardown, keep the prior `running` observation instead of
    /// planning another installation attempt.
    pub keep_running_during_destroy: bool,
    pub replaces: Option<Replaces>,
    pub validate_spec: Option<ValidateSpec>,
    pub validate_attribute: Option<ValidateAttribute>,
    pub describe: Option<Describe>,
    /// Typed inputs carried as JSON in row fields.
    pub structured: Vec<crate::Structured>,
}

impl Definition {
    pub fn new(kind: &'static str, fields: &[&'static str], mutable: &[&'static str]) -> Self {
        Self {
            kind,
            fields: fields.to_vec(),
            mutable: mutable.to_vec(),
            optional: Vec::new(),
            reset_when_omitted: Vec::new(),
            bound_fields: Vec::new(),
            computed: Vec::new(),
            generated: Vec::new(),
            protection: Protection::None,
            refuse_replacement: false,
            keep_running_during_destroy: false,
            replaces: None,
            validate_spec: None,
            validate_attribute: None,
            describe: None,
            structured: Vec::new(),
        }
    }
    pub fn optional(mut self, fields: &[&'static str]) -> Self {
        self.optional.extend_from_slice(fields);
        self
    }
    pub fn reset_when_omitted(mut self, fields: &[&'static str]) -> Self {
        self.reset_when_omitted.extend_from_slice(fields);
        self
    }
    pub fn bound_fields(mut self, fields: &[&'static str]) -> Self {
        self.bound_fields.extend_from_slice(fields);
        self
    }
    pub fn computed(mut self, name: &'static str, plan: PlanComputed) -> Self {
        self.computed.push((name, plan));
        self
    }
    pub fn generated(mut self, name: &'static str, generate: Generate) -> Self {
        self.generated.push((name, generate));
        self
    }
    pub fn protect(mut self, protection: Protection) -> Self {
        self.protection = protection;
        self
    }
    pub fn refuse_replacement(mut self) -> Self {
        self.refuse_replacement = true;
        self
    }
    pub fn keep_running_during_destroy(mut self) -> Self {
        self.keep_running_during_destroy = true;
        self
    }
    pub fn replaces(mut self, rule: Replaces) -> Self {
        self.replaces = Some(rule);
        self
    }
    pub fn validate_spec(mut self, validate: ValidateSpec) -> Self {
        self.validate_spec = Some(validate);
        self
    }
    pub fn validate_attribute(mut self, validate: ValidateAttribute) -> Self {
        self.validate_attribute = Some(validate);
        self
    }
    /// Expose row `field`, which holds JSON, as the typed input `attribute`.
    pub fn structured(
        mut self,
        attribute: &'static str,
        field: &'static str,
        shape: crate::shape::Shape,
    ) -> Self {
        self.structured.push(crate::Structured {
            attribute,
            field,
            shape,
        });
        self
    }
    pub fn describe(mut self, describe: Describe) -> Self {
        self.describe = Some(describe);
        self
    }
    pub fn is_optional(&self, field: &str) -> bool {
        self.optional.contains(&field)
    }
    pub fn is_generated(&self, field: &str) -> bool {
        self.generated.iter().any(|(name, _)| *name == field)
    }
    pub fn is_computed(&self, field: &str) -> bool {
        self.computed.iter().any(|(name, _)| *name == field)
    }
    /// Every attribute in the schema: inputs, identity, and observations.
    pub fn attributes(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.fields.iter().copied().chain(["id"]).chain(
            self.computed
                .iter()
                .map(|(name, _)| *name)
                .filter(|name| !self.fields.contains(name)),
        )
    }
}

/// Carry the prior observation forward, or plan it as unknown before one exists.
pub fn carry_prior(name: &str, prior: &State) -> Option<Value<String>> {
    Some(prior.get(name).cloned().unwrap_or(Value::Unknown))
}

/// Carry a running observation forward, but plan another installation attempt
/// when the prior observation found the process stopped.
pub fn rerun_when_stopped(name: &str, prior: &State) -> Option<Value<String>> {
    match prior.get(name) {
        Some(Value::Value(value)) if value == "false" => Some(Value::Unknown),
        other => other.cloned(),
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
    for (name, plan) in &definition.computed {
        if let Some(value) = plan(name, prior) {
            proposed.insert((*name).into(), value);
        }
    }
    let replacements = definition
        .fields
        .iter()
        .copied()
        .filter(|field| {
            (!definition.mutable.contains(field)
                || definition
                    .replaces
                    .is_some_and(|replaces| replaces(field, prior, &proposed)))
                && proposed.get(*field) != prior.get(*field)
        })
        .collect();
    (proposed, replacements)
}

mod resource;
pub mod shape;
mod structured;
pub use nemoclaw_backend::{Backend, Mutation, Row};
pub use resource::{ResourceAdapter, observation_message};
pub use structured::{Structured, StructuredAdapter, StructuredState};
