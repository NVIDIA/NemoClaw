// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl QuestionResolver<'_> {
    pub(super) fn collect_sdk_questions(
        &self,
        assessment: &PartialAssessment,
        policy: &QuestionPolicy<'_>,
        work: &mut ResolutionWork,
    ) {
        let questions = &mut work.questions;
        let omitted = &mut work.omitted;
        let warnings = &mut work.warnings;
        for field in self.definition.ask.union(&self.definition.omit) {
            if field.starts_with('/')
                && sdk_field_schema_for(&self.authored.values, field).is_none()
                && sdk_field_possible(field)
            {
                warnings.push(format!(
                    "{field} is not applicable in the current SDK schema branch"
                ));
            }
        }
        let name = self.authored.values.pointer(NAME);
        let invalid_name = assessment
            .issues()
            .iter()
            .any(|issue| issue.path() == NAME && issue.kind() == PartialIssueKind::Invalid);
        if name.is_none()
            || invalid_name
            || (self.definition.ask.contains(NAME) && !self.decisions.accepted.contains(NAME))
        {
            questions.push(JourneyQuestion {
                target: QuestionTarget::DeploymentName,
                kind: JourneyQuestionKind::Field,
                reopened_because: None,
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
                title: None,
                description: None,
            });
        }

        for field in &self.definition.ask {
            if field == NAME
                || field == HARNESS
                || field == INFERENCE_PRESET
                || adapter_field(field).is_some()
            {
                continue;
            }
            if self.decisions.omitted.contains(field) {
                omitted.push(field.clone());
                continue;
            }
            let Some((schema, required)) = sdk_field_schema_for(&self.authored.values, field)
            else {
                continue;
            };
            let schema = policy.sdk_schema(field, schema);
            let value = self.authored.values.pointer(field);
            let valid = value.is_some_and(|value| schema_accepts(&schema, value) == Some(true));
            if value.is_none() || !valid || !self.decisions.accepted.contains(field) {
                questions.push(JourneyQuestion {
                    target: QuestionTarget::sdk(field.clone()),
                    kind: JourneyQuestionKind::Field,
                    reopened_because: None,
                    id: field.clone(),
                    reason: if value.is_some() && !valid {
                        JourneyQuestionReason::InvalidSupplied
                    } else if value.is_none() {
                        JourneyQuestionReason::Missing
                    } else {
                        JourneyQuestionReason::ExplicitAsk
                    },
                    required,
                    choices: finite_choices(&schema),
                    suggestion: value.cloned().or_else(|| schema.get("default").cloned()),
                    schema,
                    title: None,
                    description: None,
                });
            }
        }

        // The SDK decides requiredness and supplied-value validity. A known
        // scalar can be answered even when the journey did not list it in
        // `ask`. Unconditional leaves of missing objects can be traversed;
        // arrays and conditional alternatives remain an explicit frontier.
        for issue in assessment.issues() {
            if issue.path() == NAME
                || issue.path() == HARNESS
                || questions.iter().any(|question| question.id == issue.path())
            {
                continue;
            }
            let supplied = self.authored.values.pointer(issue.path());
            match issue.kind() {
                PartialIssueKind::Missing if supplied.is_none() => {}
                PartialIssueKind::Invalid | PartialIssueKind::Deferred if supplied.is_some() => {}
                _ => continue,
            }
            let Some((parent, _)) = issue.path().rsplit_once('/') else {
                continue;
            };
            let Some((schema, required)) =
                sdk_field_schema_for(&self.authored.values, issue.path())
            else {
                continue;
            };
            if issue.kind() == PartialIssueKind::Deferred
                && sdk_discriminator(&schema).is_none()
                && sdk_exclusive_required_fields(&schema).is_none()
            {
                continue;
            }
            if self.authored.values.pointer(parent).is_none() {
                continue;
            }
            let schema = policy.sdk_schema(issue.path(), schema);
            let choices = finite_choices(&schema);
            if !scalar_question(&schema, &choices) {
                collect_required_leaf_questions(
                    &self.authored.values,
                    issue.path(),
                    &schema,
                    &self.position.selected_forms,
                    questions,
                    0,
                );
                continue;
            }
            questions.push(JourneyQuestion {
                target: QuestionTarget::sdk(issue.path()),
                kind: JourneyQuestionKind::Field,
                reopened_because: None,
                id: issue.path().into(),
                reason: if issue.kind() == PartialIssueKind::Missing {
                    JourneyQuestionReason::Missing
                } else {
                    JourneyQuestionReason::InvalidSupplied
                },
                required: required || issue.kind() == PartialIssueKind::Missing,
                choices,
                suggestion: supplied.cloned().or_else(|| schema.get("default").cloned()),
                schema,
                title: None,
                description: None,
            });
        }
    }
}
