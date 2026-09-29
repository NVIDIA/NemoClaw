// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded symbolic inspection of questions returned by the authoring resolver.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::{
    Capabilities, Diagnostics, JourneyDefinition, JourneyQuestionReason, JourneyState,
    PartialIssueKind, journey_definition::adapter_field, sdk_schema::sdk_schema_identity,
};

const MAX_CHOICES: usize = 32;
const MAX_BRANCH_DEPTH: usize = 3;
const MAX_BRANCHES: usize = 128;

/// Print a bounded tree by answering the same finite questions as the TUI.
/// Free input and unresolved SDK constraints remain visible frontiers.
pub(crate) fn print_tree(
    definition: &JourneyDefinition,
    capabilities: &Capabilities,
) -> Result<String, Diagnostics> {
    let state = definition.start(capabilities)?;
    let mut lines = vec![
        format!("Journey {}", definition.id),
        format!("  SDK schema: {}", sdk_schema_identity()),
    ];
    if let (Some(revision), Some(digest)) = (
        capabilities.fabric_revision.as_deref(),
        capabilities.catalog_sha256.as_deref(),
    ) {
        lines.push(format!("  Fabric revision: {revision}"));
        lines.push(format!("  Fabric catalog sha256:{digest}"));
    } else {
        lines.push("  Fabric catalog: unverified".into());
    }
    let mut printer = TreePrinter {
        capabilities,
        lines,
        branches: 0,
    };
    printer.render(&state, "  ", 0, &BTreeSet::new(), &BTreeSet::new())?;
    printer.lines.push("  Preview scope: current resolver questions and bounded finite branches; dependent free-form and conditional branches are not fully expanded.".into());
    Ok(printer.lines.join("\n"))
}

struct TreePrinter<'a> {
    capabilities: &'a Capabilities,
    lines: Vec<String>,
    branches: usize,
}

impl TreePrinter<'_> {
    fn render(
        &mut self,
        state: &JourneyState,
        indent: &str,
        depth: usize,
        shown: &BTreeSet<String>,
        expanded: &BTreeSet<String>,
    ) -> Result<(), Diagnostics> {
        let resolved = state.resolve(self.capabilities)?;
        let mut shown_here = shown.clone();
        for id in resolved.omitted() {
            if shown_here.insert(id.clone()) {
                self.lines
                    .push(format!("{indent}{}: omitted", display_id(id)));
            }
        }
        for question in resolved.questions() {
            if shown_here.insert(question.id().into()) {
                let kind = question.schema()["type"].as_str().unwrap_or("JSON value");
                let value = if question.required() {
                    format!("<{kind}>")
                } else {
                    format!("[omit | <{kind}>]")
                };
                let invalid = if question.reason() == JourneyQuestionReason::InvalidSupplied {
                    " (invalid supplied value)"
                } else {
                    ""
                };
                self.lines.push(format!(
                    "{indent}{}: {value}{}{invalid}",
                    display_id(question.id()),
                    suggestion(question.suggestion())
                ));
            }
        }
        for warning in resolved.warnings() {
            if shown_here.insert(format!("warning:{warning}")) {
                self.lines.push(format!("{indent}Warning: {warning}"));
            }
        }
        for reason in resolved.unverified() {
            if shown_here.insert(format!("unverified:{reason}")) {
                self.lines.push(format!("{indent}Unverified: {reason}"));
            }
        }
        if depth == 0 {
            let remaining = resolved
                .assessment()
                .issues()
                .iter()
                .filter(|issue| {
                    !(issue.kind() == PartialIssueKind::Missing
                        && resolved.question(issue.path()).is_some())
                })
                .collect::<Vec<_>>();
            if !remaining.is_empty() {
                self.lines
                    .push(format!("{indent}Other unresolved SDK constraints:"));
                for issue in remaining {
                    self.lines.push(format!(
                        "{indent}  {}: {:?} ({})",
                        issue.path(),
                        issue.kind(),
                        issue.rule()
                    ));
                }
            }
            if resolved.questions().is_empty()
                && resolved.assessment().issues().is_empty()
                && resolved.unverified().is_empty()
            {
                self.lines.push(format!(
                    "{indent}No configuration questions in the inspected surface"
                ));
            }
            if let Some(target) = resolved.target_assessment() {
                self.lines
                    .push(format!("{indent}Target prerequisite: {:?}", target.status));
                for reason in &target.reasons {
                    self.lines.push(format!("{indent}  {reason}"));
                }
            }
        }

        let question = resolved
            .questions()
            .iter()
            .filter(|question| !question.choices().is_empty() && !expanded.contains(question.id()))
            .max_by_key(|question| self.branch_impact(state, &resolved, question));
        let Some(question) = question else {
            return Ok(());
        };
        if depth >= MAX_BRANCH_DEPTH || self.branches >= MAX_BRANCHES {
            self.lines
                .push(format!("{indent}... finite branches not expanded"));
            return Ok(());
        }
        let impact = self.branch_impact(state, &resolved, question);
        self.lines.push(format!(
            "{indent}Choices for {}:",
            display_id(question.id())
        ));
        let mut next_expanded = expanded.clone();
        next_expanded.insert(question.id().into());
        let mut choices = question
            .choices()
            .iter()
            .take(MAX_CHOICES)
            .cloned()
            .map(Some)
            .collect::<Vec<_>>();
        if !question.required() {
            choices.push(None);
        }
        for (index, choice) in choices.into_iter().enumerate() {
            if self.branches >= MAX_BRANCHES {
                self.lines.push(format!("{indent}... branch limit reached"));
                break;
            }
            self.branches += 1;
            let label = choice.as_ref().map_or_else(
                || "omit".into(),
                |value| choice_label(question.id(), value, index),
            );
            self.lines.push(format!("{indent}  ├─ {label}"));
            let mut branch = state.clone();
            match branch.answer(self.capabilities, question.id(), choice) {
                Ok(()) if impact > 0 => self.render(
                    &branch,
                    &format!("{indent}  │  "),
                    depth + 1,
                    &shown_here,
                    &next_expanded,
                )?,
                Ok(()) => {}
                Err(_) => self.lines.push(format!(
                    "{indent}  │  Cannot resolve this choice from the current sparse base"
                )),
            }
        }
        if question.choices().len() > MAX_CHOICES {
            self.lines.push(format!(
                "{indent}  ... {} more choices not expanded",
                question.choices().len() - MAX_CHOICES
            ));
        }
        Ok(())
    }

    fn branch_impact(
        &self,
        state: &JourneyState,
        before: &crate::JourneyResolution,
        question: &crate::JourneyQuestion,
    ) -> usize {
        let baseline = before
            .questions()
            .iter()
            .filter(|other| other.id() != question.id())
            .map(|other| (other.id().to_owned(), other.choices().to_vec()))
            .collect::<Vec<_>>();
        question
            .choices()
            .iter()
            .take(MAX_CHOICES)
            .filter(|choice| {
                let mut branch = state.clone();
                if branch
                    .answer(self.capabilities, question.id(), Some((*choice).clone()))
                    .is_err()
                {
                    return true;
                }
                let Ok(after) = branch.resolve(self.capabilities) else {
                    return true;
                };
                let following = after
                    .questions()
                    .iter()
                    .filter(|other| other.id() != question.id())
                    .map(|other| (other.id().to_owned(), other.choices().to_vec()))
                    .collect::<Vec<_>>();
                baseline != following
            })
            .count()
    }
}

fn display_id(id: &str) -> &str {
    adapter_field(id).map_or(id, |(_, pointer)| pointer)
}

fn choice_label(question_id: &str, choice: &Value, index: usize) -> String {
    if question_id == "route:selection" {
        return format!("<route {}>", index + 1);
    }
    choice
        .as_str()
        .map_or_else(|| choice.to_string(), str::to_owned)
}

fn suggestion(value: Option<&Value>) -> &'static str {
    if value.is_some() {
        " (suggestion available)"
    } else {
        ""
    }
}
