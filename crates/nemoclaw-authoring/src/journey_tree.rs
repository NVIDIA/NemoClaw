// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded symbolic inspection of questions returned by the authoring resolver.

use serde_json::Value;

use crate::{
    Capabilities, Diagnostics, JourneyDefinition, JourneyQuestionReason, PartialIssueKind,
    journey_definition::{HARNESS, INFERENCE_PRESET, NAME, adapter_field},
};

const MAX_BRANCHES: usize = 32;
const MAX_SETTINGS: usize = 32;

/// Print a reviewable first tree. An unresolved frontier is never shown as
/// a complete journey; later slices expand it through the same field rules.
pub(crate) fn print_tree(
    definition: &JourneyDefinition,
    capabilities: &Capabilities,
) -> Result<String, Diagnostics> {
    let state = definition.start(capabilities)?;
    let initial = state.resolve(capabilities)?;
    let mut lines = vec![format!("Journey {}", definition.id)];
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
                    if let Some(endpoint) = resolved.question("/spec/inferenceProviders/0/endpoint")
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
                Err(_) => lines
                    .push("    │  cannot project this choice from the current sparse base".into()),
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
            !(issue.kind() == PartialIssueKind::Missing && initial.question(issue.path()).is_some())
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
    if let Some(target) = initial.target_assessment() {
        lines.push(format!("  Target prerequisite: {:?}", target.status));
        for reason in &target.reasons {
            lines.push(format!("    {reason}"));
        }
    }
    lines.push("  Preview scope: current resolver questions and bounded finite branches; dependent free-form and conditional branches are not fully expanded.".into());
    Ok(lines.join("\n"))
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
