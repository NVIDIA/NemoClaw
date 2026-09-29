// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded inspection of a journey's supplied values and native setting surface.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use nemoclaw_sdk::config::schema::input_schema;
use serde_json::Value;

use crate::{
    Capabilities, Diagnostics, JourneyQuestionReason, PartialDocument, PartialIssueKind,
    diagnostics::diagnostic,
};

pub(crate) const NAME: &str = "/metadata/name";
pub(crate) const HARNESS: &str = "/spec/sandboxes/0/harness/kind";
pub(crate) const SETTINGS: &str = "/spec/sandboxes/0/harness/settings";
pub(crate) const INFERENCE_PRESET: &str = "inference:preset";
const MAX_BRANCHES: usize = 32;
const MAX_SETTINGS: usize = 32;

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
    id: String,
    pub(crate) base: PartialDocument,
    pub(crate) ask: BTreeSet<String>,
    pub(crate) ask_order: Vec<String>,
    pub(crate) ask_scopes: BTreeSet<JourneyScope>,
    pub(crate) omit: BTreeSet<String>,
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
            if sdk_field_schema(field).is_some() {
                continue;
            }
            let Some((adapter, pointer)) = adapter_field(field) else {
                return Err(diagnostic(
                    "journey",
                    &format!("cannot ask '{field}' in this preview"),
                ));
            };
            let Some(schema) = adapter_schema(capabilities, adapter)? else {
                continue;
            };
            if schema["properties"].get(&pointer[1..]).is_none() {
                return Err(diagnostic(
                    "journey",
                    &format!("adapter '{adapter}' has no setting '{pointer}'"),
                ));
            }
        }
        for field in &self.omit {
            let Some((adapter, pointer)) = adapter_field(field) else {
                return Err(diagnostic(
                    "journey",
                    &format!("cannot omit '{field}' in this preview"),
                ));
            };
            let Some(property) = pointer.strip_prefix('/') else {
                return Err(diagnostic(
                    "journey",
                    "adapter setting paths must start with '/'",
                ));
            };
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
            let Some(schema) = adapter_schema(capabilities, adapter)? else {
                continue;
            };
            if schema["properties"].get(property).is_none() {
                return Err(diagnostic(
                    "journey",
                    &format!("adapter '{adapter}' has no setting '{pointer}'"),
                ));
            }
            if schema["required"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item == property))
            {
                return Err(diagnostic(
                    "journey",
                    &format!("required setting '{field}' cannot be omitted"),
                ));
            }
        }
        Ok(())
    }

    /// Print a reviewable first tree. An unresolved frontier is never shown as
    /// a complete journey; later slices expand it through the same field rules.
    pub fn print_tree(&self, capabilities: &Capabilities) -> Result<String, Diagnostics> {
        let state = self.start(capabilities)?;
        let initial = state.resolve(capabilities)?;
        let mut lines = vec![format!("Journey {}", self.id)];
        let mut questions = 0;
        if let Some(name) = initial.question(NAME) {
            questions += 1;
            lines.push(format!(
                "  {NAME}: <valid name>{}",
                suggestion(name.suggestion())
            ));
        }

        let branch_harness = initial.question(HARNESS);
        let harnesses = if let Some(question) = branch_harness {
            question
                .choices()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        } else {
            state
                .values()
                .pointer(HARNESS)
                .and_then(Value::as_str)
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        if let Some(question) = branch_harness {
            questions += 1;
            lines.push(format!(
                "  {HARNESS}: choose adapter{}",
                suggestion(question.suggestion())
            ));
        }
        let mut unverified_adapter = false;
        for harness in harnesses.iter().take(MAX_BRANCHES) {
            if branch_harness.is_some() {
                lines.push(format!("    ├─ {harness}"));
            }
            let indent = if branch_harness.is_some() {
                "    │  "
            } else {
                "  "
            };
            let mut branch = state.clone();
            if branch_harness.is_some() {
                branch.answer(capabilities, HARNESS, Some(Value::String(harness.clone())))?;
            }
            let resolved = branch.resolve(capabilities)?;
            if !resolved.unverified().is_empty() {
                unverified_adapter = true;
                for reason in resolved.unverified() {
                    lines.push(format!("{indent}{reason}"));
                }
            }
            for id in resolved.omitted().iter().take(MAX_SETTINGS) {
                if let Some((_, pointer)) = adapter_field(id) {
                    lines.push(format!("{indent}{pointer}: omitted"));
                }
            }
            let setting_questions = resolved
                .questions()
                .iter()
                .filter(|question| question.id().starts_with("adapter:"))
                .collect::<Vec<_>>();
            for question in setting_questions.iter().take(MAX_SETTINGS) {
                let Some((_, pointer)) = adapter_field(question.id()) else {
                    continue;
                };
                questions += 1;
                let kind = question.schema()["type"].as_str().unwrap_or("JSON value");
                let options = if question.required() {
                    format!("<{kind}>")
                } else {
                    format!("[omit | <{kind}>]")
                };
                lines.push(format!(
                    "{indent}{pointer}: {options}{}{}",
                    suggestion(question.suggestion()),
                    invalid_note(question.reason())
                ));
            }
            if setting_questions.len() > MAX_SETTINGS {
                lines.push(format!(
                    "{indent}... {} more settings not expanded",
                    setting_questions.len() - MAX_SETTINGS
                ));
            }
        }
        if harnesses.len() > MAX_BRANCHES {
            lines.push(format!(
                "    ... {} more adapters not expanded",
                harnesses.len() - MAX_BRANCHES
            ));
        }

        if let Some(preset) = initial.question(INFERENCE_PRESET) {
            questions += 1;
            lines.push(format!(
                "  {INFERENCE_PRESET}: choose endpoint preset{}",
                suggestion(preset.suggestion())
            ));
            for choice in preset.choices().iter().take(MAX_BRANCHES) {
                let Some(id) = choice.as_str() else { continue };
                lines.push(format!("    ├─ {id}"));
                let mut branch = state.clone();
                match branch.answer(capabilities, INFERENCE_PRESET, Some(choice.clone())) {
                    Ok(()) => {
                        let resolved = branch.resolve(capabilities)?;
                        for question in resolved.questions().iter().filter(|question| {
                            question.id() == "/spec/inferenceProviders/0/api"
                                || question.id()
                                    == "/spec/sandboxes/0/agent/inference/routes/0/overrides/model"
                        }) {
                            questions += 1;
                            lines.push(format!(
                                "    │  {}: <valid value>{}",
                                question.id(),
                                suggestion(question.suggestion())
                            ));
                        }
                        if let Some(endpoint) =
                            resolved.question("/spec/inferenceProviders/0/endpoint")
                        {
                            questions += 1;
                            lines.push(format!(
                                "    │  {}: <URL>{}",
                                endpoint.id(),
                                suggestion(endpoint.suggestion())
                            ));
                            if let Some(sample) = endpoint.suggestion() {
                                let mut after_endpoint = branch.clone();
                                if after_endpoint
                                    .answer(capabilities, endpoint.id(), Some(sample.clone()))
                                    .is_ok()
                                    && let Some(model) = after_endpoint.resolve(capabilities)?.question(
                                        "/spec/sandboxes/0/agent/inference/routes/0/overrides/model",
                                    )
                                {
                                    questions += 1;
                                    lines.push(format!(
                                        "    │    then {}: <valid model>{}",
                                        model.id(),
                                        suggestion(model.suggestion())
                                    ));
                                }
                            }
                        }
                    }
                    Err(_) => lines.push(
                        "    │  cannot project this choice from the current sparse base".into(),
                    ),
                }
            }
        }

        for question in initial.questions().iter().filter(|question| {
            let id = question.id();
            (id.starts_with('/') && id != NAME && id != HARNESS)
                || id.starts_with("workflow:")
                || id.starts_with("model:")
                || id == "route:selection"
        }) {
            questions += 1;
            let kind = question.schema()["type"].as_str().unwrap_or("JSON value");
            lines.push(format!(
                "  {}: <{kind}>{}{}",
                question.id(),
                suggestion(question.suggestion()),
                invalid_note(question.reason())
            ));
        }

        let remaining_issues = initial
            .assessment()
            .issues()
            .iter()
            .filter(|issue| {
                !(issue.kind() == PartialIssueKind::Missing
                    && initial.question(issue.path()).is_some())
            })
            .collect::<Vec<_>>();
        if !remaining_issues.is_empty() {
            lines.push("  Other unresolved SDK constraints:".into());
            for issue in remaining_issues {
                lines.push(format!(
                    "    {}: {:?} ({})",
                    issue.path(),
                    issue.kind(),
                    issue.rule()
                ));
            }
        }
        if questions == 0 && initial.assessment().issues().is_empty() && !unverified_adapter {
            lines.push("  No configuration questions in the inspected surface".into());
        }
        for warning in initial.warnings() {
            lines.push(format!("  Warning: {warning}"));
        }
        lines.push("  Preview scope: current resolver questions and bounded finite branches; dependent free-form and conditional branches are not fully expanded.".into());
        Ok(lines.join("\n"))
    }
}

/// Find a field in the SDK input schema without maintaining a parallel list of
/// document constraints. The v1 journey supports existing object properties and
/// array elements; conditional branches remain a separate resolution problem.
pub(crate) fn sdk_field_schema(path: &str) -> Option<(Value, bool)> {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    let root = SCHEMA.get_or_init(input_schema);
    let mut node = root;
    let mut required = false;
    for part in path.strip_prefix('/')?.split('/') {
        node = follow_ref(root, node)?;
        if part.parse::<usize>().is_ok() {
            node = node.get("items")?;
            required = true;
        } else {
            let name = part.replace("~1", "/").replace("~0", "~");
            required = node
                .get("required")
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| item == &name));
            node = node.get("properties")?.get(&name)?;
        }
    }
    let mut field = follow_ref(root, node)?.clone();
    if let Some(object) = field.as_object_mut() {
        object.insert("$defs".into(), root.get("$defs")?.clone());
    }
    Some((field, required))
}

fn follow_ref<'a>(root: &'a Value, mut node: &'a Value) -> Option<&'a Value> {
    for _ in 0..16 {
        let Some(reference) = node.get("$ref").and_then(Value::as_str) else {
            return Some(node);
        };
        node = root.pointer(reference.strip_prefix('#')?)?;
    }
    None
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
    path.starts_with('/').then_some((adapter, path))
}

fn suggestion(value: Option<&Value>) -> String {
    value.map_or(String::new(), |_| " (suggestion available)".into())
}

fn invalid_note(reason: JourneyQuestionReason) -> &'static str {
    if reason == JourneyQuestionReason::InvalidSupplied {
        " (invalid supplied value)"
    } else {
        ""
    }
}
