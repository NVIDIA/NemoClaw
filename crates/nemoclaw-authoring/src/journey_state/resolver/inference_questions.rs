// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl QuestionResolver<'_> {
    pub(super) fn collect_inference_questions(&self, work: &mut ResolutionWork) {
        let questions = &mut work.questions;
        if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::RouteModels)
        {
            if let Some(path) = self.route_model_path() {
                if let Some(existing) = questions.iter_mut().find(|question| question.id == path) {
                    existing.kind = JourneyQuestionKind::InferenceModel;
                } else if !self.decisions.accepted.contains(&path)
                    && let Some((schema, required)) = sdk_field_schema(&path)
                {
                    let value = self.authored.values.pointer(&path);
                    questions.push(JourneyQuestion {
                        target: QuestionTarget::sdk(path.clone()),
                        kind: JourneyQuestionKind::InferenceModel,
                        reopened_because: None,
                        id: path,
                        reason: if value.is_some() {
                            JourneyQuestionReason::ExplicitAsk
                        } else {
                            JourneyQuestionReason::Missing
                        },
                        required,
                        choices: Vec::new(),
                        suggestion: value.cloned(),
                        schema,
                    });
                }
            }
            if let Some(routes) = routes_path(&self.authored.values)
                .and_then(|path| self.authored.values.pointer(&path))
                .and_then(Value::as_array)
                && routes.len() > 1
            {
                let current_pending = self
                    .route_model_path()
                    .is_some_and(|path| questions.iter().any(|question| question.id == path));
                if !current_pending {
                    let choices = routes
                        .iter()
                        .enumerate()
                        .filter(|(index, _)| {
                            Some(*index) != self.position.selected_route
                                && !self.position.completed_routes.contains(index)
                        })
                        .filter_map(|(_, route)| route.get("name").cloned())
                        .collect::<Vec<_>>();
                    let choices = if self.position.selected_route.is_none() {
                        routes
                            .iter()
                            .filter_map(|route| route.get("name").cloned())
                            .collect::<Vec<_>>()
                    } else {
                        choices
                    };
                    if !choices.is_empty() {
                        questions.push(JourneyQuestion {
                            target: QuestionTarget::RouteSelection {
                                routes: routes
                                    .iter()
                                    .enumerate()
                                    .filter_map(|(index, route)| {
                                        route
                                            .get("name")
                                            .and_then(Value::as_str)
                                            .map(|name| (name.to_owned(), index))
                                    })
                                    .collect(),
                            },
                            kind: JourneyQuestionKind::Field,
                            reopened_because: None,
                            id: ROUTE_SELECTION.into(),
                            reason: JourneyQuestionReason::Missing,
                            required: true,
                            choices,
                            suggestion: None,
                            schema: serde_json::json!({"type":"string"}),
                        });
                    }
                }
            }
        }

        if self.definition.ask.contains(INFERENCE_PRESET)
            && self.route_provider().is_some()
            && !self
                .position
                .selected_route
                .is_some_and(|route| self.decisions.accepted_presets.contains(&route))
        {
            let suggestion = self
                .current_preset()
                .map(|preset| Value::String(preset.id().into()));
            questions.push(JourneyQuestion {
                target: QuestionTarget::InferencePreset {
                    route: self
                        .position
                        .selected_route
                        .expect("selected external route"),
                },
                kind: JourneyQuestionKind::Field,
                reopened_because: None,
                id: INFERENCE_PRESET.into(),
                reason: if suggestion.is_some() {
                    JourneyQuestionReason::ExplicitAsk
                } else {
                    JourneyQuestionReason::Missing
                },
                required: true,
                choices: ProviderPreset::ALL
                    .into_iter()
                    .map(|preset| Value::String(preset.id().into()))
                    .collect(),
                suggestion,
                schema: serde_json::json!({"type":"string"}),
            });
        }
        if self
            .definition
            .ask_scopes
            .contains(&JourneyScope::InferenceApi)
            && let Some(provider) = self.provider_path()
        {
            let path = format!("{provider}/api");
            if !self.decisions.accepted.contains(&path)
                && !questions.iter().any(|question| question.id == path)
                && let Some((mut schema, required)) = sdk_field_schema(&path)
            {
                if let Some(preset) = self.current_preset() {
                    schema["enum"] = Value::Array(
                        preset
                            .apis()
                            .iter()
                            .map(|api| serde_json::to_value(api).expect("SDK API serializes"))
                            .collect(),
                    );
                }
                let value = self.authored.values.pointer(&path);
                questions.push(JourneyQuestion {
                    target: QuestionTarget::sdk(path.clone()),
                    kind: JourneyQuestionKind::Field,
                    reopened_because: None,
                    id: path,
                    reason: if value.is_some() {
                        JourneyQuestionReason::ExplicitAsk
                    } else {
                        JourneyQuestionReason::Missing
                    },
                    required,
                    choices: finite_choices(&schema),
                    suggestion: value.cloned(),
                    schema,
                });
            }
        }
        if self.definition.ask.contains(INFERENCE_PRESET)
            && self
                .position
                .selected_route
                .and_then(|route| self.decisions.selected_presets.get(&route))
                .is_some_and(|preset| preset.profile().custom_endpoint)
            && self.provider_path().is_some_and(|path| {
                !self
                    .decisions
                    .accepted
                    .contains(&format!("{path}/endpoint"))
            })
            && !questions.iter().any(|question| {
                self.provider_path()
                    .is_some_and(|path| question.id == format!("{path}/endpoint"))
            })
        {
            let endpoint = format!(
                "{}/endpoint",
                self.provider_path().expect("external provider")
            );
            let schema = sdk_field_schema(&endpoint)
                .expect("external provider endpoint is in the SDK schema")
                .0;
            questions.push(JourneyQuestion {
                target: QuestionTarget::sdk(endpoint.clone()),
                kind: JourneyQuestionKind::Field,
                reopened_because: None,
                id: endpoint.clone(),
                reason: JourneyQuestionReason::ExplicitAsk,
                required: true,
                choices: Vec::new(),
                suggestion: self.authored.values.pointer(&endpoint).cloned(),
                schema,
            });
        }
    }
}
