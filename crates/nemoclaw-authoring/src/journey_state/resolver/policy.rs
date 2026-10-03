// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Prompt dependencies and presentation order for one resolution pass.

use super::*;

/// Collectors discover candidates from schemas. This policy owns which candidates
/// may be presented together and how guided inference decisions constrain them.
pub(super) struct QuestionPolicy<'a> {
    definition: &'a JourneyDefinition,
    decisions: &'a DecisionRecord,
    provider: Option<String>,
    model: Option<String>,
    preset: Option<ProviderPreset>,
    preset_pending: bool,
    endpoint_pending: Option<String>,
}

impl<'a> QuestionPolicy<'a> {
    pub(super) fn new(resolver: &QuestionResolver<'a>) -> Self {
        let provider = resolver.provider_path();
        let preset_pending = resolver.definition.ask.contains(INFERENCE_PRESET)
            && provider.is_some()
            && !resolver
                .position
                .selected_route
                .is_some_and(|route| resolver.decisions.accepted_presets.contains(&route));
        let endpoint_pending = resolver
            .position
            .selected_route
            .and_then(|route| resolver.decisions.selected_presets.get(&route))
            .filter(|preset| preset.profile().custom_endpoint)
            .and(provider.as_ref())
            .map(|path| format!("{path}/endpoint"))
            .filter(|path| !resolver.decisions.accepted.contains(path));
        Self {
            definition: resolver.definition,
            decisions: resolver.decisions,
            provider,
            model: resolver.route_model_path(),
            preset: resolver.current_preset(),
            preset_pending,
            endpoint_pending,
        }
    }

    pub(super) fn preset_pending(&self) -> bool {
        self.preset_pending
    }

    pub(super) fn endpoint_pending(&self) -> Option<&str> {
        self.endpoint_pending.as_deref()
    }

    /// Exact selectors and scope selectors share the same provider API choices.
    pub(super) fn sdk_schema(&self, path: &str, mut schema: Value) -> Value {
        if self
            .provider
            .as_ref()
            .is_some_and(|provider| path == format!("{provider}/api"))
            && let Some(preset) = self.preset
        {
            schema["enum"] = Value::Array(
                preset
                    .apis()
                    .iter()
                    .map(|api| serde_json::to_value(api).expect("SDK API serializes"))
                    .collect(),
            );
        }
        schema
    }

    fn is_current_model(&self, target: &QuestionTarget) -> bool {
        matches!(target, QuestionTarget::SdkField { path, .. } if self.model.as_ref() == Some(path))
    }

    fn is_current_api(&self, target: &QuestionTarget) -> bool {
        matches!(target, QuestionTarget::SdkField { path, role: SdkFieldRole::ProviderApi }
            if self.provider.as_ref().is_some_and(|provider| path == &format!("{provider}/api")))
    }

    fn allows(&self, target: &QuestionTarget, model_pending: bool) -> bool {
        if matches!(target, QuestionTarget::RouteSelection { .. }) && model_pending {
            return false;
        }
        if self.preset_pending {
            if let QuestionTarget::SdkField { path, .. } = target
                && self
                    .provider
                    .as_ref()
                    .is_some_and(|provider| path.starts_with(&format!("{provider}/")))
            {
                return false;
            }
            if self.is_current_model(target) {
                return false;
            }
        }
        self.endpoint_pending.is_none() || !self.is_current_model(target)
    }

    pub(super) fn apply(&self, values: &Value, work: &mut ResolutionWork) {
        for field in &self.definition.omit {
            if field.starts_with('/') && sdk_field_schema_for(values, field).is_some() {
                work.omitted.push(field.clone());
            }
        }
        let model_pending = work
            .questions
            .iter()
            .any(|question| self.is_current_model(&question.target));
        work.questions.retain(|question| {
            !self.definition.omit.contains(question.id())
                && self.allows(&question.target, model_pending)
        });
        work.omitted.sort();
        work.omitted.dedup();
        for question in &mut work.questions {
            question.reopened_because = self.decisions.reopened_by.get(question.id()).cloned();
        }
        work.questions.sort_by_key(|question| {
            (
                matches!(question.target, QuestionTarget::RouteSelection { .. }),
                self.definition
                    .ask_order
                    .iter()
                    .position(|id| id == question.id())
                    .unwrap_or(usize::MAX),
            )
        });
        // Preserve authored order for independent questions. The current API
        // must precede its model even when guidance lists the model first.
        if let (Some(api), Some(model)) = (
            work.questions
                .iter()
                .position(|q| self.is_current_api(&q.target)),
            work.questions
                .iter()
                .position(|q| self.is_current_model(&q.target)),
        ) && api > model
        {
            let question = work.questions.remove(api);
            work.questions.insert(model, question);
        }
    }
}
