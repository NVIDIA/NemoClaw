// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Resolution of the bounded journey surface against sparse authored values.

use std::collections::{BTreeMap, BTreeSet};

use nemoclaw_sdk::config::Document;
use nemoclaw_sdk::fabric_capabilities::schema_accepts;
use serde_json::{Map, Value};

use crate::{
    Capabilities, Diagnostics, PartialAssessment, PartialDocument, PartialIssueKind,
    diagnostics::diagnostic,
    journey_definition::{
        HARNESS, JourneyDefinition, NAME, SETTINGS, adapter_field, adapter_schema, sdk_field_schema,
    },
};

/// Why an applicable decision is still open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JourneyQuestionReason {
    Missing,
    ExplicitAsk,
    InvalidSupplied,
}

/// One currently applicable decision in the bounded journey surface.
#[derive(Clone, Debug, PartialEq)]
pub struct JourneyQuestion {
    id: String,
    reason: JourneyQuestionReason,
    required: bool,
    choices: Vec<Value>,
    suggestion: Option<Value>,
    schema: Value,
}

impl JourneyQuestion {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn reason(&self) -> JourneyQuestionReason {
        self.reason
    }
    pub fn required(&self) -> bool {
        self.required
    }
    pub fn choices(&self) -> &[Value] {
        &self.choices
    }
    pub fn suggestion(&self) -> Option<&Value> {
        self.suggestion.as_ref()
    }
    pub fn schema(&self) -> &Value {
        &self.schema
    }
}

/// A fresh result, recomputed after each answer or catalog change.
#[derive(Clone, Debug)]
pub struct JourneyResolution {
    questions: Vec<JourneyQuestion>,
    omitted: Vec<String>,
    warnings: Vec<String>,
    unverified: Vec<String>,
    assessment: PartialAssessment,
}

impl JourneyResolution {
    pub fn questions(&self) -> &[JourneyQuestion] {
        &self.questions
    }
    pub fn question(&self, id: &str) -> Option<&JourneyQuestion> {
        self.questions.iter().find(|question| question.id == id)
    }
    pub fn next_question(&self) -> Option<&JourneyQuestion> {
        self.questions.first()
    }
    pub fn omitted(&self) -> &[String] {
        &self.omitted
    }
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }
    pub fn unverified(&self) -> &[String] {
        &self.unverified
    }
    pub fn assessment(&self) -> &PartialAssessment {
        &self.assessment
    }

    /// SDK-valid desired state only after every question in this resolver's
    /// current surface is answered and no Fabric schema is unverified.
    /// Target compatibility remains a separate check.
    pub fn materialized_document(&self) -> Option<&Document> {
        if self.questions.is_empty() && self.unverified.is_empty() {
            self.assessment.document()
        } else {
            None
        }
    }
}

/// Mutable answers and explicit omissions over a journey definition's sparse base.
#[derive(Clone, Debug)]
pub struct JourneyState {
    definition: JourneyDefinition,
    values: Value,
    accepted: BTreeSet<String>,
    omitted: BTreeSet<String>,
    inactive_settings: BTreeMap<String, Value>,
}

impl JourneyState {
    pub(crate) fn new(definition: JourneyDefinition) -> Self {
        let values = definition.base.supplied().clone();
        Self {
            definition,
            values,
            accepted: BTreeSet::new(),
            omitted: BTreeSet::new(),
            inactive_settings: BTreeMap::new(),
        }
    }

    pub fn values(&self) -> &Value {
        &self.values
    }

    /// Resolve identity, harness, guided SDK field guidance, and top-level adapter
    /// settings. Unasked SDK requirements and conditional Fabric branches remain explicit.
    pub fn resolve(&self, capabilities: &Capabilities) -> Result<JourneyResolution, Diagnostics> {
        self.definition.validate_guidance(capabilities)?;
        let assessment = PartialDocument::from_value(self.values.clone()).assess();
        let mut questions = Vec::new();
        let mut omitted = Vec::new();
        let mut unverified = Vec::new();
        let mut warnings = Vec::new();
        let name = self.values.pointer(NAME);
        let invalid_name = assessment
            .issues()
            .iter()
            .any(|issue| issue.path() == NAME && issue.kind() == PartialIssueKind::Invalid);
        if name.is_none()
            || invalid_name
            || (self.definition.ask.contains(NAME) && !self.accepted.contains(NAME))
        {
            questions.push(JourneyQuestion {
                id: NAME.into(),
                reason: if invalid_name {
                    JourneyQuestionReason::InvalidSupplied
                } else if name.is_none() {
                    JourneyQuestionReason::Missing
                } else {
                    JourneyQuestionReason::ExplicitAsk
                },
                required: true,
                choices: Vec::new(),
                suggestion: name.cloned(),
                schema: serde_json::json!({"type":"string"}),
            });
        }

        for field in &self.definition.ask {
            if field == NAME || field == HARNESS || adapter_field(field).is_some() {
                continue;
            }
            if self.omitted.contains(field) {
                omitted.push(field.clone());
                continue;
            }
            let Some((schema, required)) = sdk_field_schema(field) else {
                continue;
            };
            let value = self.values.pointer(field);
            let valid = value.is_some_and(|value| schema_accepts(&schema, value) == Some(true));
            if value.is_none() || !valid || !self.accepted.contains(field) {
                questions.push(JourneyQuestion {
                    id: field.clone(),
                    reason: if value.is_some() && !valid {
                        JourneyQuestionReason::InvalidSupplied
                    } else if value.is_none() {
                        JourneyQuestionReason::Missing
                    } else {
                        JourneyQuestionReason::ExplicitAsk
                    },
                    required,
                    choices: schema["enum"].as_array().cloned().unwrap_or_default(),
                    suggestion: value.cloned().or_else(|| schema.get("default").cloned()),
                    schema,
                });
            }
        }

        let chosen = self.values.pointer(HARNESS).and_then(Value::as_str);
        let harness_open = chosen.is_none()
            || (self.definition.ask.contains(HARNESS) && !self.accepted.contains(HARNESS));
        let reachable: Vec<&str> = if harness_open {
            capabilities
                .harnesses()
                .iter()
                .map(|harness| harness.as_str())
                .collect()
        } else {
            chosen.into_iter().collect()
        };
        for field in self.definition.ask.union(&self.definition.omit) {
            if let Some((adapter, _)) = adapter_field(field)
                && !reachable.contains(&adapter)
            {
                let reason = if harness_open {
                    "available harness choices".to_owned()
                } else {
                    format!("selected harness '{}'", chosen.expect("selected harness"))
                };
                warnings.push(format!("{field} is not reachable from {reason}"));
            }
        }
        if harness_open {
            if capabilities.harnesses().is_empty() {
                unverified
                    .push("no harness choices are advertised by the current Fabric catalog".into());
            }
            questions.push(JourneyQuestion {
                id: HARNESS.into(),
                reason: if chosen.is_none() {
                    JourneyQuestionReason::Missing
                } else {
                    JourneyQuestionReason::ExplicitAsk
                },
                required: true,
                choices: capabilities
                    .harnesses()
                    .iter()
                    .map(|harness| Value::String(harness.as_str().into()))
                    .collect(),
                suggestion: self.values.pointer(HARNESS).cloned(),
                schema: serde_json::json!({"type":"string"}),
            });
        } else if let Some(harness) = chosen {
            let Some(schema) = adapter_schema(capabilities, harness)? else {
                unverified.push(format!("adapter schema unverified for '{harness}'"));
                return Ok(self.resolution(questions, omitted, warnings, unverified, assessment));
            };
            let Some(properties) = schema["properties"].as_object() else {
                unverified.push(format!(
                    "adapter '{harness}' has no enumerable top-level settings"
                ));
                return Ok(self.resolution(questions, omitted, warnings, unverified, assessment));
            };
            for (property, property_schema) in properties {
                let pointer = format!("/{}", escape(property));
                let id = format!("adapter:{harness}:{pointer}");
                let value = self.values.pointer(&format!("{SETTINGS}{pointer}"));
                let required = schema["required"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item == property));
                if self.definition.omit.contains(&id) || self.omitted.contains(&id) {
                    omitted.push(id);
                    continue;
                }
                let mut field_schema = property_schema.clone();
                if let Some(defs) = schema.get("$defs")
                    && field_schema.is_object()
                {
                    field_schema["$defs"] = defs.clone();
                }
                let valid =
                    value.is_some_and(|value| schema_accepts(&field_schema, value) == Some(true));
                if value.is_none()
                    || !valid
                    || (self.definition.ask.contains(&id) && !self.accepted.contains(&id))
                {
                    questions.push(JourneyQuestion {
                        id,
                        reason: if value.is_some() && !valid {
                            JourneyQuestionReason::InvalidSupplied
                        } else if value.is_none() {
                            JourneyQuestionReason::Missing
                        } else {
                            JourneyQuestionReason::ExplicitAsk
                        },
                        required,
                        choices: property_schema["enum"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                        suggestion: value
                            .cloned()
                            .or_else(|| property_schema.get("default").cloned()),
                        schema: field_schema,
                    });
                }
            }
            let settings = self
                .values
                .pointer(SETTINGS)
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            if questions
                .iter()
                .all(|question| !question.id.starts_with("adapter:"))
                && schema_accepts(schema, &settings) != Some(true)
            {
                unverified.push(format!("adapter '{harness}' settings do not satisfy the complete Fabric schema; nested or conditional questions are not expanded"));
            }
        }

        Ok(self.resolution(questions, omitted, warnings, unverified, assessment))
    }

    fn resolution(
        &self,
        mut questions: Vec<JourneyQuestion>,
        omitted: Vec<String>,
        warnings: Vec<String>,
        unverified: Vec<String>,
        assessment: PartialAssessment,
    ) -> JourneyResolution {
        questions.sort_by_key(|question| {
            self.definition
                .ask_order
                .iter()
                .position(|id| id == question.id())
                .unwrap_or(usize::MAX)
        });
        JourneyResolution {
            questions,
            omitted,
            warnings,
            unverified,
            assessment,
        }
    }

    /// Accept or omit an active answer. Previously accepted fields may be
    /// revisited; invalid answers leave the state unchanged.
    pub fn answer(
        &mut self,
        capabilities: &Capabilities,
        id: &str,
        value: Option<Value>,
    ) -> Result<(), Diagnostics> {
        let resolution = self.resolve(capabilities)?;
        let question = if let Some(question) = resolution.question(id) {
            question.clone()
        } else if self.accepted.contains(id) {
            self.revisitable_question(capabilities, id)?
        } else {
            return Err(diagnostic("journey", "This question is not active."));
        };
        if value.is_none() && question.required {
            return Err(diagnostic("journey", "This question is required."));
        }
        if id == HARNESS && question.choices.is_empty() {
            return Err(diagnostic(
                "journey",
                "No harness choices are advertised by the current Fabric catalog.",
            ));
        }
        if let Some(value) = &value
            && !question.choices.is_empty()
            && !question.choices.contains(value)
        {
            return Err(diagnostic(
                "journey",
                "The answer is not an advertised choice.",
            ));
        }
        if let Some(value) = &value
            && schema_accepts(&question.schema, value) != Some(true)
        {
            return Err(diagnostic(
                "journey",
                "The answer does not satisfy its field schema.",
            ));
        }
        let mut candidate = self.clone();
        if id == NAME {
            candidate.put_name(value.expect("required"))?;
            if PartialDocument::from_value(candidate.values.clone())
                .assess()
                .issues()
                .iter()
                .any(|issue| issue.path() == NAME && issue.kind() == PartialIssueKind::Invalid)
            {
                return Err(diagnostic(
                    "journey",
                    "The deployment name does not satisfy the SDK schema.",
                ));
            }
        } else if id == HARNESS {
            candidate.put_harness(value.expect("required"))?;
        } else if let Some((adapter, pointer)) = adapter_field(id) {
            if candidate.values.pointer(HARNESS).and_then(Value::as_str) != Some(adapter) {
                return Err(diagnostic("journey", "This adapter setting is not active."));
            }
            candidate.put_setting(pointer, value.clone())?;
            if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else if self.definition.ask.contains(id) && sdk_field_schema(id).is_some() {
            candidate.put_sdk_field(id, value.clone())?;
            if value.is_none() {
                candidate.omitted.insert(id.into());
            } else {
                candidate.omitted.remove(id);
            }
        } else {
            return Err(diagnostic("journey", "This question is not supported."));
        }
        candidate.accepted.insert(id.into());
        *self = candidate;
        Ok(())
    }

    fn revisitable_question(
        &self,
        capabilities: &Capabilities,
        id: &str,
    ) -> Result<JourneyQuestion, Diagnostics> {
        let mut previous = self.clone();
        previous.accepted.remove(id);
        previous.omitted.remove(id);
        let suggestion = if id == NAME || id == HARNESS {
            let value = previous.values.pointer(id).cloned();
            if id == NAME {
                previous
                    .values
                    .pointer_mut("/metadata")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
                    .remove("name");
            } else {
                previous
                    .values
                    .pointer_mut("/spec/sandboxes/0/harness")
                    .and_then(Value::as_object_mut)
                    .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?
                    .remove("kind");
            }
            value
        } else if let Some((adapter, pointer)) = adapter_field(id) {
            if previous.values.pointer(HARNESS).and_then(Value::as_str) != Some(adapter) {
                return Err(diagnostic(
                    "journey",
                    "This question is no longer applicable.",
                ));
            }
            let value = previous
                .values
                .pointer(&format!("{SETTINGS}{pointer}"))
                .cloned();
            previous.put_setting(pointer, None)?;
            value
        } else if sdk_field_schema(id).is_some() {
            previous.values.pointer(id).cloned()
        } else {
            return Err(diagnostic(
                "journey",
                "This question is no longer applicable.",
            ));
        };
        let mut question = previous
            .resolve(capabilities)?
            .question(id)
            .cloned()
            .ok_or_else(|| diagnostic("journey", "This question is no longer applicable."))?;
        if suggestion.is_some() {
            question.suggestion = suggestion;
        }
        Ok(question)
    }

    fn put_name(&mut self, value: Value) -> Result<(), Diagnostics> {
        let root = self
            .values
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "The document root must be an object."))?;
        let metadata = root
            .entry("metadata")
            .or_insert_with(|| Value::Object(Map::new()));
        metadata
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Metadata must be an object."))?
            .insert("name".into(), value);
        Ok(())
    }

    fn put_harness(&mut self, value: Value) -> Result<(), Diagnostics> {
        let next = value
            .as_str()
            .ok_or_else(|| diagnostic("journey", "Harness must be a string."))?
            .to_owned();
        let previous = self
            .values
            .pointer(HARNESS)
            .and_then(Value::as_str)
            .map(str::to_owned);
        if previous.as_deref() != Some(&next)
            && let Some(old) = &previous
            && let Some(settings) = self.values.pointer(SETTINGS)
        {
            self.inactive_settings.insert(old.clone(), settings.clone());
        }
        let sandbox = self
            .values
            .pointer_mut("/spec/sandboxes/0")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The v1 journey requires one sandbox object."))?;
        let harness = sandbox
            .entry("harness")
            .or_insert_with(|| Value::Object(Map::new()));
        let harness = harness
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        if previous.as_deref() != Some(&next) {
            harness.remove("settings");
            if let Some(settings) = self.inactive_settings.get(&next) {
                harness.insert("settings".into(), settings.clone());
            }
        }
        harness.insert("kind".into(), Value::String(next));
        Ok(())
    }

    fn put_setting(&mut self, pointer: &str, value: Option<Value>) -> Result<(), Diagnostics> {
        let property = pointer
            .strip_prefix('/')
            .ok_or_else(|| diagnostic("journey", "Invalid adapter setting path."))?
            .replace("~1", "/")
            .replace("~0", "~");
        let harness = self
            .values
            .pointer_mut("/spec/sandboxes/0/harness")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "Harness must be an object."))?;
        let settings = harness
            .entry("settings")
            .or_insert_with(|| Value::Object(Map::new()));
        let settings = settings
            .as_object_mut()
            .ok_or_else(|| diagnostic("journey", "Adapter settings must be an object."))?;
        if let Some(value) = value {
            settings.insert(property, value);
        } else {
            settings.remove(&property);
        }
        Ok(())
    }

    fn put_sdk_field(&mut self, pointer: &str, value: Option<Value>) -> Result<(), Diagnostics> {
        let (parent, property) = pointer
            .rsplit_once('/')
            .ok_or_else(|| diagnostic("journey", "Invalid SDK field path."))?;
        let property = property.replace("~1", "/").replace("~0", "~");
        let object = self
            .values
            .pointer_mut(parent)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| diagnostic("journey", "The SDK field's parent is not an object."))?;
        if let Some(value) = value {
            object.insert(property, value);
        } else {
            object.remove(&property);
        }
        Ok(())
    }
}

fn escape(part: &str) -> String {
    part.replace('~', "~0").replace('/', "~1")
}
