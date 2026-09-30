// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl QuestionResolver<'_> {
    pub(super) fn collect_deployment_questions(
        &self,
        inspect_values: &Value,
        work: &mut ResolutionWork,
    ) -> Result<(), Diagnostics> {
        let questions = &mut work.questions;
        if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::DeploymentFields)
        {
            let active_harness = harness_path(inspect_values);
            let active_routes = routes_path(inspect_values);
            for field in crate::deployment::deployment_questions_for_values(
                inspect_values,
                active_harness.as_deref(),
                active_routes.as_deref(),
            )? {
                if self.decisions.accepted.contains(&field.path)
                    || questions.iter().any(|question| question.id == field.path)
                {
                    continue;
                }
                questions.push(JourneyQuestion {
                    target: QuestionTarget::sdk(field.path.clone()),
                    kind: JourneyQuestionKind::Field,
                    reopened_because: None,
                    id: field.path,
                    // A `false` schema marks a supplied key the SDK does not define.
                    reason: if field.schema == Value::Bool(false) {
                        JourneyQuestionReason::InvalidSupplied
                    } else {
                        JourneyQuestionReason::ExplicitAsk
                    },
                    required: field.required,
                    choices: field.choices,
                    suggestion: field.suggestion,
                    schema: field.schema,
                });
            }
        }
        Ok(())
    }
}
