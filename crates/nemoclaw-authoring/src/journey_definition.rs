// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded inspection of a journey's supplied values and native setting surface.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::{Capabilities, Diagnostics, PartialDocument, diagnostics::diagnostic};

const NAME: &str = "/metadata/name";
const HARNESS: &str = "/spec/sandboxes/0/harness/kind";
const SETTINGS: &str = "/spec/sandboxes/0/harness/settings";
const MAX_BRANCHES: usize = 32;
const MAX_SETTINGS: usize = 32;

/// A deployment seed and deliberate prompt or omission guidance.
/// The preview currently expands one sandbox's identity and adapter settings;
/// other SDK constraints remain visible as an unresolved frontier.
#[derive(Clone, Debug)]
pub struct JourneyDefinition {
    id: String,
    base: PartialDocument,
    ask: BTreeSet<String>,
    omit: BTreeSet<String>,
}

impl JourneyDefinition {
    pub fn new(id: impl Into<String>, base: PartialDocument) -> Self {
        Self {
            id: id.into(),
            base,
            ask: BTreeSet::new(),
            omit: BTreeSet::new(),
        }
    }

    pub fn ask(mut self, fields: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.ask.extend(fields.into_iter().map(Into::into));
        self
    }

    pub fn omit(mut self, fields: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.omit.extend(fields.into_iter().map(Into::into));
        self
    }

    /// Print a reviewable first tree. An unresolved frontier is never shown as
    /// a complete journey; later slices expand it through the same field rules.
    pub fn print_tree(&self, capabilities: &Capabilities) -> Result<String, Diagnostics> {
        if let Some(field) = self.ask.intersection(&self.omit).next() {
            return Err(diagnostic(
                "journey",
                &format!("'{field}' cannot be both asked and omitted"),
            ));
        }
        for field in &self.ask {
            if field == NAME || field == HARNESS {
                continue;
            }
            let Some((adapter, pointer)) = adapter_field(field) else {
                return Err(diagnostic(
                    "journey",
                    &format!("cannot ask '{field}' in this preview"),
                ));
            };
            let Some(schema) = adapter_schema(capabilities, adapter)? else {
                return Err(diagnostic(
                    "journey",
                    &format!("adapter '{adapter}' has no setting schema"),
                ));
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
            let Some(schema) = adapter_schema(capabilities, adapter)? else {
                return Err(diagnostic(
                    "journey",
                    &format!("adapter '{adapter}' has no setting schema"),
                ));
            };
            let Some(property) = pointer.strip_prefix('/') else {
                return Err(diagnostic(
                    "journey",
                    "adapter setting paths must start with '/'",
                ));
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
        }

        let mut lines = vec![format!("Journey {}", self.id)];
        let mut questions = 0;
        let name = self.base.supplied().pointer(NAME);
        if name.is_none() || self.ask.contains(NAME) {
            questions += 1;
            lines.push(format!("  {NAME}: <valid name>{}", suggestion(name)));
        }

        let chosen = self
            .base
            .supplied()
            .pointer(HARNESS)
            .and_then(Value::as_str);
        let branch_harness = chosen.is_none() || self.ask.contains(HARNESS);
        let harnesses = if branch_harness {
            capabilities
                .harnesses()
                .iter()
                .map(|harness| harness.as_str().to_owned())
                .collect::<Vec<_>>()
        } else {
            vec![chosen.expect("selected harness").to_owned()]
        };
        if branch_harness {
            questions += 1;
            lines.push(format!(
                "  {HARNESS}: choose adapter{}",
                suggestion(self.base.supplied().pointer(HARNESS))
            ));
        }
        for harness in harnesses.iter().take(MAX_BRANCHES) {
            if branch_harness {
                lines.push(format!("    ├─ {harness}"));
            }
            let indent = if branch_harness { "    │  " } else { "  " };
            let Some(schema) = adapter_schema(capabilities, harness)? else {
                lines.push(format!("{indent}adapter schema unverified"));
                continue;
            };
            let Some(properties) = schema["properties"].as_object() else {
                continue;
            };
            let required = schema["required"].as_array();
            for (property, field_schema) in properties.iter().take(MAX_SETTINGS) {
                let pointer = format!("/{property}");
                let id = format!("adapter:{harness}:{pointer}");
                let value = (chosen == Some(harness.as_str()))
                    .then(|| {
                        self.base
                            .supplied()
                            .pointer(&format!("{SETTINGS}{pointer}"))
                    })
                    .flatten();
                if self.omit.contains(&id) {
                    lines.push(format!("{indent}{pointer}: omitted"));
                    continue;
                }
                if value.is_some() && !self.ask.contains(&id) {
                    continue;
                }
                questions += 1;
                let required =
                    required.is_some_and(|items| items.iter().any(|item| item == property));
                let kind = field_schema["type"].as_str().unwrap_or("JSON value");
                let options = if required {
                    format!("<{kind}>")
                } else {
                    format!("[omit | <{kind}>]")
                };
                lines.push(format!(
                    "{indent}{pointer}: {options}{}",
                    suggestion(value.or_else(|| field_schema.get("default")))
                ));
            }
            if properties.len() > MAX_SETTINGS {
                lines.push(format!(
                    "{indent}... {} more settings not expanded",
                    properties.len() - MAX_SETTINGS
                ));
            }
        }
        if harnesses.len() > MAX_BRANCHES {
            lines.push(format!(
                "    ... {} more adapters not expanded",
                harnesses.len() - MAX_BRANCHES
            ));
        }

        let assessment = self.base.assess();
        if !assessment.issues().is_empty() {
            lines.push("  Other unresolved SDK constraints:".into());
            for issue in assessment.issues() {
                if issue.path() == NAME || issue.path() == HARNESS {
                    continue;
                }
                lines.push(format!(
                    "    {}: {:?} ({})",
                    issue.path(),
                    issue.kind(),
                    issue.rule()
                ));
            }
        }
        if questions == 0 && assessment.issues().is_empty() {
            lines.push("  No configuration questions in the inspected surface".into());
        }
        lines.push("  Preview scope: name, harness choice, top-level adapter settings; remaining SDK and Fabric branches are not expanded.".into());
        Ok(lines.join("\n"))
    }
}

fn adapter_schema<'a>(
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

fn adapter_field(field: &str) -> Option<(&str, &str)> {
    let suffix = field.strip_prefix("adapter:")?;
    let (adapter, path) = suffix.split_once(':')?;
    path.starts_with('/').then_some((adapter, path))
}

fn suggestion(value: Option<&Value>) -> String {
    value.map_or(String::new(), |_| " (suggestion available)".into())
}
