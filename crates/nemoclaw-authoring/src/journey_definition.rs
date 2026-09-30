// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Sparse values and deliberate question guidance for one onboarding journey.

use serde_json::Value;
use std::collections::BTreeSet;

use crate::{
    Capabilities, Diagnostics, PartialDocument,
    diagnostics::diagnostic,
    sdk_schema::{sdk_field_possible, sdk_field_schema_for},
};

pub(crate) const NAME: &str = "/metadata/name";
pub(crate) const HARNESS: &str = "/spec/sandboxes/0/harness/kind";
pub(crate) const SETTINGS: &str = "/spec/sandboxes/0/harness/settings";
pub(crate) const INFERENCE_PRESET: &str = "inference:preset";

/// A schema-discovered family of applicable questions. The schema determines
/// which fields exist and whether they are required; this only asks to review
/// supplied values in that family.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum JourneyScope {
    ActiveAdapterSettings,
    NativeSettings,
    RouteModels,
    InferenceApi,
    DeploymentFields,
}

/// A target check that a journey requires before its completed document is
/// ready to leave authoring. The observation remains separate from authored
/// desired state.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum TargetPrerequisite {
    EngineAndImageCompatible,
}

/// Select one field or a family discovered from the active SDK and Fabric
/// schemas. Selection controls prompting, not applicability or requiredness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JourneySelector {
    Field(String),
    Scope(JourneyScope),
}

impl From<&str> for JourneySelector {
    fn from(value: &str) -> Self {
        Self::Field(value.into())
    }
}

impl From<String> for JourneySelector {
    fn from(value: String) -> Self {
        Self::Field(value)
    }
}

impl From<JourneyScope> for JourneySelector {
    fn from(value: JourneyScope) -> Self {
        Self::Scope(value)
    }
}

/// A deployment seed and deliberate prompt or omission guidance.
/// The preview currently expands one sandbox's identity and adapter settings;
/// other SDK constraints remain visible as an unresolved frontier.
#[derive(Clone, Debug)]
pub struct JourneyDefinition {
    pub(crate) id: String,
    pub(crate) base: PartialDocument,
    pub(crate) ask: BTreeSet<String>,
    pub(crate) ask_order: Vec<String>,
    pub(crate) ask_scopes: BTreeSet<JourneyScope>,
    pub(crate) omit: BTreeSet<String>,
    pub(crate) target_prerequisites: BTreeSet<TargetPrerequisite>,
}

impl JourneyDefinition {
    pub fn new(id: impl Into<String>, base: PartialDocument) -> Self {
        Self {
            id: id.into(),
            base,
            ask: BTreeSet::new(),
            ask_order: Vec::new(),
            ask_scopes: BTreeSet::new(),
            omit: BTreeSet::new(),
            target_prerequisites: BTreeSet::new(),
        }
    }

    pub fn ask(mut self, selectors: impl IntoIterator<Item = impl Into<JourneySelector>>) -> Self {
        for selector in selectors {
            match selector.into() {
                JourneySelector::Field(field) => {
                    if self.ask.insert(field.clone()) {
                        self.ask_order.push(field);
                    }
                }
                JourneySelector::Scope(scope) => {
                    self.ask_scopes.insert(scope);
                }
            }
        }
        self
    }

    pub fn omit(mut self, fields: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.omit.extend(fields.into_iter().map(Into::into));
        self
    }

    pub fn require_target(
        mut self,
        prerequisites: impl IntoIterator<Item = TargetPrerequisite>,
    ) -> Self {
        self.target_prerequisites.extend(prerequisites);
        self
    }

    /// Start mutable resolution over the sparse v1 single-sandbox envelope.
    pub fn start(&self, capabilities: &Capabilities) -> Result<crate::JourneyState, Diagnostics> {
        self.validate_guidance(capabilities)?;
        if !self
            .base
            .supplied()
            .pointer("/spec/sandboxes")
            .and_then(Value::as_array)
            .is_some_and(|sandboxes| sandboxes.len() == 1 && sandboxes[0].is_object())
        {
            return Err(diagnostic(
                "journey",
                "The v1 journey requires exactly one sandbox object.",
            ));
        }
        Ok(crate::JourneyState::new(self.clone()))
    }

    pub(crate) fn validate_guidance(&self, capabilities: &Capabilities) -> Result<(), Diagnostics> {
        if let Some(field) = self.ask.intersection(&self.omit).next() {
            return Err(diagnostic(
                "journey",
                &format!("'{field}' cannot be both asked and omitted"),
            ));
        }
        for field in &self.ask {
            if field == NAME || field == HARNESS || field == INFERENCE_PRESET {
                continue;
            }
            if sdk_field_schema_for(self.base.supplied(), field).is_some()
                || sdk_field_possible(field)
            {
                continue;
            }
            if native_field(field) {
                continue;
            }
            let Some((adapter, _)) = adapter_field(field) else {
                return Err(diagnostic(
                    "journey",
                    &format!("cannot ask '{field}' in this preview"),
                ));
            };
            adapter_schema(capabilities, adapter)?;
        }
        for field in &self.omit {
            if field.starts_with('/') {
                let current = sdk_field_schema_for(self.base.supplied(), field);
                if current.is_none() && !sdk_field_possible(field) {
                    return Err(diagnostic(
                        "journey",
                        &format!("cannot omit '{field}' in this preview"),
                    ));
                }
                if current.is_some_and(|(_, required)| required) {
                    return Err(diagnostic(
                        "journey",
                        &format!("required SDK field '{field}' cannot be omitted"),
                    ));
                }
                if self.base.supplied().pointer(field).is_some() {
                    return Err(diagnostic(
                        "journey",
                        &format!("supplied SDK field '{field}' cannot be omitted"),
                    ));
                }
                continue;
            }
            if native_field(field) {
                continue;
            }
            let Some((adapter, pointer)) = adapter_field(field) else {
                return Err(diagnostic(
                    "journey",
                    &format!("cannot omit '{field}' in this preview"),
                ));
            };
            if pointer.is_empty() {
                return Err(diagnostic(
                    "journey",
                    "required adapter settings alternatives cannot be omitted",
                ));
            }
            if self
                .base
                .supplied()
                .pointer(HARNESS)
                .and_then(Value::as_str)
                == Some(adapter)
                && self
                    .base
                    .supplied()
                    .pointer(&format!("{SETTINGS}{pointer}"))
                    .is_some()
            {
                return Err(diagnostic(
                    "journey",
                    &format!("supplied setting '{field}' cannot be omitted"),
                ));
            }
            adapter_schema(capabilities, adapter)?;
        }
        Ok(())
    }

    /// Print a bounded symbolic preview using the current question resolver.
    pub fn print_tree(&self, capabilities: &Capabilities) -> Result<String, Diagnostics> {
        crate::journey_tree::print_tree(self, capabilities)
    }
}

pub(crate) fn adapter_schema<'a>(
    capabilities: &'a Capabilities,
    adapter: &str,
) -> Result<Option<&'a Value>, Diagnostics> {
    let Some(alternatives) = capabilities.schemas.get(adapter) else {
        return Ok(None);
    };
    let Some((_, schema)) = alternatives.first() else {
        return Ok(None);
    };
    if alternatives.iter().any(|(_, other)| other != schema) {
        return Err(diagnostic(
            "journey",
            &format!("adapter '{adapter}' has ambiguous setting schemas"),
        ));
    }
    Ok(Some(schema))
}

pub(crate) fn adapter_field(field: &str) -> Option<(&str, &str)> {
    let suffix = field.strip_prefix("adapter:")?;
    let (adapter, path) = suffix.split_once(':')?;
    (!adapter.is_empty() && (path.is_empty() || path.starts_with('/'))).then_some((adapter, path))
}

pub(crate) fn native_field(field: &str) -> bool {
    field == "workflow:/target_id"
        || field == "workflow:/settings"
        || field.starts_with("workflow:/settings/")
        || field
            .strip_prefix("model:/")
            .is_some_and(|path| !path.is_empty())
}
