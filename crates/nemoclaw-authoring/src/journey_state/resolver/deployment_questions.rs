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
            let active_routes = routes_path(inspect_values);
            let known_engine = self.known_engine();
            for field in crate::deployment::deployment_questions_for_values(
                inspect_values,
                active_routes.as_deref(),
            )? {
                if self.decisions.accepted.contains(&field.path)
                    || questions.iter().any(|question| question.id == field.path)
                    || known_engine.as_ref() == Some(&field.path)
                {
                    continue;
                }
                questions.push(JourneyQuestion {
                    target: QuestionTarget::sdk(field.path.clone()),
                    kind: JourneyQuestionKind::Field,
                    reopened_because: None,
                    note: None,
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
                    title: field.title,
                    description: field.description,
                });
            }
        }
        Ok(())
    }

    /// The managed gateway's engine path, when its engine is the one socket
    /// that answered on this machine for the chosen target, so there is
    /// nothing to ask.
    fn known_engine(&self) -> Option<String> {
        let answered = self.answered_engines?;
        let values = &self.authored.values;
        if values
            .pointer("/spec/gateway/management")
            .and_then(Value::as_str)
            != Some("managed")
        {
            return None;
        }
        let (target, path) = gateway_engine(values)?;
        let mut engines = answered
            .iter()
            .filter(|engine| engine.compute_driver.as_str() == target);
        let (Some(only), None) = (engines.next(), engines.next()) else {
            return None;
        };
        (values.pointer(&path).and_then(Value::as_str) == Some(only.engine.as_str()))
            .then_some(path)
    }
}
